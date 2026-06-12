import "server-only";

import { MODEL_PROVIDER_MODEL_IDS, SYSTEM_PROMPT } from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { requireModelProviderApiKey } from "@/lib/model-provider-keys";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolCall } from "@/lib/tools/recordTool";
import type { Memory as MastraMemory } from "@mastra/memory";

let sharedMastraMemory: MastraMemory | null = null;

function logMastraLane(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/lane/mastra] ${phase}`, details ?? {});
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
  const graphlitTools = createGraphlitTools(client).map((item) =>
    recordGraphlitToolCall(item, recorder),
  );

  try {
    logMastraLane("memory.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
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
    const [{ Agent }, { createTool }] = await Promise.all([
      import("@mastra/core/agent"),
      import("@mastra/core/tools"),
    ]);
    logMastraLane("sdk.import.complete", {
      runId: context.runId,
      turnId: context.turnId,
    });
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
    const agent = new Agent({
      id: "graphlit-knowledge-agent",
      name: "Graphlit Knowledge Agent",
      instructions: SYSTEM_PROMPT,
      model,
      tools,
      memory,
    });
    recorder.mergeSession({
      mastraResourceId: resourceId,
      mastraThreadId: threadId,
    });
    logMastraLane("generate.start", {
      runId: context.runId,
      turnId: context.turnId,
      model: modelId,
      modelProvider: context.modelProvider,
      resourceId,
      threadId,
      toolCount: Object.keys(tools).length,
    });
    const result = await agent.generate(context.prompt, {
      memory: {
        resource: resourceId,
        thread: threadId,
      },
      runId: context.runId,
      maxSteps: 8,
      abortSignal: context.abortSignal,
    });
    logMastraLane("generate.complete", {
      runId: context.runId,
      turnId: context.turnId,
      resourceId,
      threadId,
    });
    recorder.recordRaw(result);
    await recorder.emitSnapshot(mastraOutputText(result));

    return recorder.result();
  } catch (error) {
    logMastraLane("generate.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: errorMessage(error),
    });
    return recorder.result(errorMessage(error));
  }
}
