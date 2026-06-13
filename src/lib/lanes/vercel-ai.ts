import "server-only";

import {
  MODEL_PROVIDER_MODEL_IDS,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { emitTextStream, sentenceChunk } from "@/lib/lanes/streaming";
import { requireModelProviderApiKey } from "@/lib/model-provider-keys";
import type {
  JsonValue,
  LaneRunContext,
  LaneRunResult,
  LaneSessionState,
} from "@/lib/types";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolCall } from "@/lib/tools/recordTool";
import { errorMessage, safeJson } from "@/lib/utils";
import type { ModelMessage, ToolSet } from "ai";

function logVercelLane(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/lane/vercel] ${phase}`, details ?? {});
}

function storedVercelMessages(session?: LaneSessionState): ModelMessage[] {
  const messages = session?.vercelMessages;

  return Array.isArray(messages) ? (messages as unknown as ModelMessage[]) : [];
}

function serializableMessages(messages: ModelMessage[]): JsonValue[] {
  const value = safeJson(messages);

  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export async function runVercelAiLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  const recorder = new LaneRunRecorder({
    laneId: "vercel",
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
  const instructions = mergeAgentInstructions(
    context.systemPrompt,
    context.runtimeInstructions,
  );

  try {
    logVercelLane("sdk.import.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("vercel.sdk.import.start");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "vercel",
      event: { phase: "vercel.sdk.import.start" },
    });
    const { ToolLoopAgent, smoothStream, stepCountIs, tool } = await import(
      "ai"
    );
    const modelId = MODEL_PROVIDER_MODEL_IDS[context.modelProvider][
      context.modelSize
    ];
    const model =
      context.modelProvider === "anthropic"
        ? (await import("@ai-sdk/anthropic")).createAnthropic({
            apiKey: requireModelProviderApiKey(
              "anthropic",
              "the Vercel AI SDK lane",
            ),
          })(modelId)
        : context.modelProvider === "google"
          ? (await import("@ai-sdk/google")).createGoogleGenerativeAI({
              apiKey: requireModelProviderApiKey(
                "google",
                "the Vercel AI SDK lane",
              ),
            })(modelId)
          : (await import("@ai-sdk/openai")).createOpenAI({
              apiKey: requireModelProviderApiKey(
                "openai",
                "the Vercel AI SDK lane",
              ),
            })(modelId);
    logVercelLane("sdk.import.complete", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("vercel.sdk.import.complete", {
      model: modelId,
      modelProvider: context.modelProvider,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "vercel",
      event: { phase: "vercel.sdk.import.complete" },
    });

    const tools = Object.fromEntries(
      graphlitTools.map((item) => [
        item.tool.name,
        tool({
          description: item.tool.description ?? `Run ${item.tool.name}.`,
          inputSchema: item.inputSchema as never,
          execute: async (
            args: unknown,
            options: { abortSignal?: AbortSignal },
          ) =>
            item.handler(
              args,
              undefined,
              options.abortSignal ?? context.abortSignal,
            ),
        }),
      ]),
    ) as ToolSet;
    const messages: ModelMessage[] = [
      ...storedVercelMessages(context.laneSession),
      { role: "user", content: context.prompt },
    ];
    const agent = new ToolLoopAgent({
      id: "graphlit-knowledge-agent",
      model,
      instructions,
      tools,
      prepareStep: ({ stepNumber }) => ({
        toolChoice: stepNumber === 0 ? "required" : "auto",
      }),
      stopWhen: stepCountIs(8),
      providerOptions:
        context.modelProvider === "openai"
          ? {
              openai: {
                reasoningEffort: context.reasoningEffort,
              },
            }
          : undefined,
    });

    logVercelLane("stream.start", {
      runId: context.runId,
      turnId: context.turnId,
      model: modelId,
      modelProvider: context.modelProvider,
      toolCount: Object.keys(tools).length,
    });
    recorder.recordPhase("vercel.stream.start", {
      model: modelId,
      modelProvider: context.modelProvider,
      toolCount: Object.keys(tools).length,
      toolChoice: "required_first",
      streaming: {
        api: "ToolLoopAgent.stream",
        cadence: "sentence",
      },
    });
    const result = await agent.stream({
      messages,
      abortSignal: context.abortSignal,
      experimental_transform: smoothStream({
        chunking: sentenceChunk,
        delayInMs: 20,
      }),
    });
    await emitTextStream(result.textStream, recorder);
    const [finalText, response, totalUsage, steps, finishReason] =
      await Promise.all([
        result.text,
        result.response,
        result.totalUsage,
        result.steps,
        result.finishReason,
      ]);
    logVercelLane("stream.complete", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("vercel.stream.complete", {
      finishReason,
    });

    const nextMessages = [
      ...messages,
      ...(response.messages ?? []),
    ] as ModelMessage[];
    recorder.mergeSession({
      vercelMessages: serializableMessages(nextMessages),
    });
    recorder.recordTokenUsage(totalUsage, "Vercel AI SDK total usage");
    recorder.recordRaw(
      safeJson({
        finishReason,
        response,
        steps,
        totalUsage,
        streaming: {
          api: "ToolLoopAgent.stream",
          cadence: "sentence",
        },
      }),
    );

    if (!recorder.getAnswer()) {
      await recorder.emitSnapshot(finalText);
    }

    return recorder.result();
  } catch (error) {
    logVercelLane("stream.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: errorMessage(error),
    });
    return recorder.result(errorMessage(error));
  }
}
