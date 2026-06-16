import "server-only";

import {
  AGENT_MAX_STEPS,
  ANALYZE_PROMPT_TOOL_NAME,
  MODEL_PROVIDER_MODEL_IDS,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { emitTextStream, lastStructuredStepText } from "@/lib/lanes/streaming";
import {
  isTransientProviderConnectionError,
  summarizeProviderError,
} from "@/lib/lanes/transientErrors";
import { requireModelProviderApiKey } from "@/lib/model-provider-keys";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorDetails, errorMessage, safeJson } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolsWithRequiredFirst } from "@/lib/tools/recordTool";
import type { Memory as MastraMemory } from "@mastra/memory";

let sharedMastraMemory: MastraMemory | null = null;

const MASTRA_ANTHROPIC_MODEL_RETRIES = 2;
const MASTRA_ANTHROPIC_OUTER_RETRIES = 1;
const MASTRA_ANTHROPIC_STEP_TIMEOUT_MS = 120_000;
const MASTRA_ANTHROPIC_CHUNK_TIMEOUT_MS = 90_000;
const MASTRA_RETRY_BASE_DELAY_MS = 750;

function logMastraLane(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/lane/mastra] ${phase}`, details ?? {});
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;

  if (reason instanceof Error) {
    return reason;
  }

  return new Error(
    typeof reason === "string" ? reason : "Mastra lane retry was aborted.",
  );
}

async function waitForRetry(ms: number, signal: AbortSignal | undefined) {
  if (ms <= 0) {
    return;
  }

  if (signal?.aborted) {
    throw abortReason(signal);
  }

  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };

    timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createMastraAttemptSignal(
  parentSignal: AbortSignal | undefined,
  timeout:
    | {
        stepMs: number;
        chunkMs: number;
      }
    | undefined,
) {
  const controller = new AbortController();
  let stepTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let chunkTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const abort = (error: Error) => {
    if (!controller.signal.aborted) {
      controller.abort(error);
    }
  };
  const onParentAbort = () => abort(abortReason(parentSignal));

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  if (timeout) {
    stepTimeoutId = setTimeout(
      () =>
        abort(
          new Error(
            `Mastra Anthropic stream step timed out after ${timeout.stepMs}ms.`,
          ),
        ),
      timeout.stepMs,
    );
  }

  const clearStepTimeout = () => {
    if (stepTimeoutId) {
      clearTimeout(stepTimeoutId);
      stepTimeoutId = undefined;
    }
  };
  const clearChunkTimeout = () => {
    if (chunkTimeoutId) {
      clearTimeout(chunkTimeoutId);
      chunkTimeoutId = undefined;
    }
  };
  const armChunkTimeout = () => {
    if (!timeout) {
      return;
    }

    clearChunkTimeout();
    chunkTimeoutId = setTimeout(
      () =>
        abort(
          new Error(
            `Mastra Anthropic stream chunk timed out after ${timeout.chunkMs}ms.`,
          ),
        ),
      timeout.chunkMs,
    );
  };
  const cleanup = () => {
    clearStepTimeout();
    clearChunkTimeout();
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  return {
    signal: controller.signal,
    clearStepTimeout,
    armChunkTimeout,
    clearChunkTimeout,
    cleanup,
  };
}

async function getMastraMemory(): Promise<MastraMemory> {
  if (sharedMastraMemory) {
    return sharedMastraMemory;
  }

  // Mastra keeps memory packages separate from the core agent package.
  const [{ Memory }, { LibSQLStore }] = await Promise.all([
    import("@mastra/memory"),
    import("@mastra/libsql"),
  ]);

  sharedMastraMemory = new Memory({
    storage: new LibSQLStore({
      id: "agent-harness-lab-memory",
      url: ":memory:",
    }),
    options: {
      lastMessages: 24,
    },
  });

  return sharedMastraMemory;
}

function mastraToolArgs(args: unknown): unknown {
  if (
    args &&
    typeof args === "object" &&
    "context" in args &&
    Object.keys(args).length === 1
  ) {
    return (args as { context: unknown }).context;
  }

  return args;
}

function mastraOutputText(result: unknown): string {
  if (result && typeof result === "object") {
    if (
      "text" in result &&
      typeof (result as { text?: unknown }).text === "string"
    ) {
      return (result as { text: string }).text;
    }

    if (
      "response" in result &&
      typeof (result as { response?: unknown }).response === "string"
    ) {
      return (result as { response: string }).response;
    }
  }

  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

export async function runMastraLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  const recorder = new LaneRunRecorder({
    laneId: "mastra",
    runId: context.runId,
    turnId: context.turnId,
    prompt: context.prompt,
    reasoningEffort: context.reasoningEffort,
    modelProvider: context.modelProvider,
    modelSize: context.modelSize,
    emit: context.emit,
  });
  recorder.setSession(context.laneSession ?? {});
  const client = createGraphlitClient();
  const graphlitTools = recordGraphlitToolsWithRequiredFirst(
    createGraphlitTools(client),
    recorder,
    ANALYZE_PROMPT_TOOL_NAME,
  );
  const instructions = mergeAgentInstructions(
    context.systemPrompt,
    context.runtimeInstructions,
  );

  try {
    logMastraLane("memory.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("mastra.memory.start");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "mastra",
      event: { phase: "mastra.memory.start" },
    });
    const resourceId =
      context.laneSession?.mastraResourceId ?? context.sessionId;
    const threadId =
      context.laneSession?.mastraThreadId ?? crypto.randomUUID();
    const memory = await getMastraMemory();
    logMastraLane("memory.complete", {
      runId: context.runId,
      turnId: context.turnId,
      resourceId,
      threadId,
    });
    recorder.recordPhase("mastra.memory.complete", {
      resourceId,
      threadId,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "mastra",
      event: { phase: "mastra.memory.complete" },
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "mastra",
      event: { phase: "mastra.sdk.import.start" },
    });
    logMastraLane("sdk.import.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("mastra.sdk.import.start");
    const [{ Agent }, { createTool }] = await Promise.all([
      import("@mastra/core/agent"),
      import("@mastra/core/tools"),
    ]);
    logMastraLane("sdk.import.complete", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("mastra.sdk.import.complete");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "mastra",
      event: { phase: "mastra.sdk.import.complete" },
    });
    const tools = Object.fromEntries(
      graphlitTools.map((item) => [
        item.tool.name,
        createTool({
          id: item.tool.name,
          description: item.tool.description ?? `Run ${item.tool.name}.`,
          inputSchema: item.inputSchema as never,
          execute: async (
            args: unknown,
            execContext?: { abortSignal?: AbortSignal },
          ) =>
            item.handler(
              mastraToolArgs(args),
              undefined,
              execContext?.abortSignal ?? context.abortSignal,
            ),
        }),
      ]),
    );
    const modelId = MODEL_PROVIDER_MODEL_IDS[context.modelProvider][
      context.modelSize
    ];
    const model =
      context.modelProvider === "anthropic"
        ? (await import("@ai-sdk/anthropic")).createAnthropic({
            apiKey: requireModelProviderApiKey(
              "anthropic",
              "the Mastra lane",
            ),
          })(modelId)
        : context.modelProvider === "google"
          ? (await import("@ai-sdk/google")).createGoogleGenerativeAI({
              apiKey: requireModelProviderApiKey("google", "the Mastra lane"),
            })(modelId)
          : (await import("@ai-sdk/openai")).createOpenAI({
              apiKey: requireModelProviderApiKey("openai", "the Mastra lane"),
            })(modelId);
    const mastraModelRetries =
      context.modelProvider === "anthropic"
        ? MASTRA_ANTHROPIC_MODEL_RETRIES
        : 0;
    const agent = new Agent({
      id: "graphlit-knowledge-agent",
      name: "Graphlit Knowledge Agent",
      instructions: instructions ?? "",
      model,
      tools,
      memory,
      maxRetries: mastraModelRetries,
    });
    recorder.mergeSession({
      mastraResourceId: resourceId,
      mastraThreadId: threadId,
    });
    const maxAttempts =
      context.modelProvider === "anthropic"
        ? MASTRA_ANTHROPIC_OUTER_RETRIES + 1
        : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      logMastraLane("stream.start", {
        runId: context.runId,
        turnId: context.turnId,
        model: modelId,
        modelProvider: context.modelProvider,
        resourceId,
        threadId,
        toolCount: Object.keys(tools).length,
        attempt,
        maxAttempts,
        modelRetries: mastraModelRetries,
      });
      recorder.recordPhase("mastra.stream.start", {
        model: modelId,
        modelProvider: context.modelProvider,
        resourceId,
        threadId,
        toolCount: Object.keys(tools).length,
        toolChoice: "analyze_prompt_first",
        attempt,
        maxAttempts,
        modelRetries: mastraModelRetries,
        streaming: {
          api: "Agent.stream().textStream",
          cadence: "native",
        },
        timeout:
          context.modelProvider === "anthropic"
            ? {
                stepMs: MASTRA_ANTHROPIC_STEP_TIMEOUT_MS,
                chunkMs: MASTRA_ANTHROPIC_CHUNK_TIMEOUT_MS,
              }
            : undefined,
      });

      try {
        const timeout =
          context.modelProvider === "anthropic"
            ? {
                stepMs: MASTRA_ANTHROPIC_STEP_TIMEOUT_MS,
                chunkMs: MASTRA_ANTHROPIC_CHUNK_TIMEOUT_MS,
              }
            : undefined;
        const attemptSignal = createMastraAttemptSignal(
          context.abortSignal,
          timeout,
        );

        try {
          const result = await agent.stream(context.prompt, {
            memory: {
              resource: resourceId,
              thread: threadId,
            },
            runId: context.runId,
            maxSteps: AGENT_MAX_STEPS,
            prepareStep: ({ stepNumber }) => ({
              toolChoice:
                stepNumber === 0
                  ? {
                      type: "tool" as const,
                      toolName: ANALYZE_PROMPT_TOOL_NAME,
                    }
                  : "auto",
            }),
            abortSignal: attemptSignal.signal,
          });
          attemptSignal.clearStepTimeout();
          attemptSignal.armChunkTimeout();

          await emitTextStream(result.textStream, recorder, {
            onChunk: attemptSignal.armChunkTimeout,
          });
          attemptSignal.clearChunkTimeout();

          const [finalText, fullOutput, totalUsage, steps] = await Promise.all([
            result.text,
            result.getFullOutput(),
            result.totalUsage,
            "steps" in result ? result.steps : Promise.resolve(undefined),
          ]);
          logMastraLane("stream.complete", {
            runId: context.runId,
            turnId: context.turnId,
            resourceId,
            threadId,
            attempt,
          });
          recorder.recordPhase("mastra.stream.complete", {
            resourceId,
            threadId,
            attempt,
          });
          recorder.recordTokenUsage(totalUsage, "Mastra total usage");
          recorder.recordRaw(
            safeJson({
              output: fullOutput,
              steps,
              totalUsage,
              streaming: {
                api: "Agent.stream().textStream",
                cadence: "native",
              },
              attempt,
            }),
          );

          const structuredFinalText = lastStructuredStepText(steps);
          const resolvedFinalText =
            structuredFinalText || finalText || mastraOutputText(fullOutput);

          if (resolvedFinalText && resolvedFinalText !== recorder.getAnswer()) {
            await recorder.emitSnapshot(resolvedFinalText);
          }

          return recorder.result();
        } finally {
          attemptSignal.cleanup();
        }
      } catch (error) {
        const errorSummary = summarizeProviderError(error);
        const isTransient = isTransientProviderConnectionError(error);
        const retrySkipReason =
          attempt >= maxAttempts
            ? "max_attempts"
            : context.abortSignal?.aborted
              ? "aborted"
              : recorder.hasVisibleActivity()
                ? "visible_activity"
                : !isTransient
                  ? "not_transient"
                  : undefined;

        if (!retrySkipReason) {
          const delayMs = MASTRA_RETRY_BASE_DELAY_MS * attempt;
          const event = {
            phase: "mastra.stream.retry.scheduled",
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            delayMs,
            error: errorSummary,
          };

          recorder.recordPhase(event.phase, event);
          await context.emit({
            type: "lane_trace",
            runId: context.runId,
            turnId: context.turnId,
            laneId: "mastra",
            event,
          });
          await waitForRetry(delayMs, context.abortSignal);
          continue;
        }

        if (context.modelProvider === "anthropic") {
          recorder.recordPhase("mastra.stream.retry.skipped", {
            attempt,
            maxAttempts,
            reason: retrySkipReason,
            isTransient,
            error: errorSummary,
          });
        }

        throw error;
      }
    }

    throw new Error("Mastra stream finished without producing a result.");
  } catch (error) {
    const message = errorMessage(error);
    const details = errorDetails(error);

    logMastraLane("stream.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: message,
      details,
    });
    recorder.recordRaw(
      safeJson({
        type: "lane_error",
        phase: "mastra.stream.failed",
        error: details,
      }),
    );
    return recorder.result(message);
  }
}
