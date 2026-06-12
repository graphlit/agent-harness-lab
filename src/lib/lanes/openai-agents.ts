import "server-only";

import { OPENAI_MODELS, SYSTEM_PROMPT } from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage, safeJson } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolCall } from "@/lib/tools/recordTool";
import type { AgentInputItem } from "@openai/agents";

function logOpenAiLane(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/lane/openai] ${phase}`, details ?? {});
}

function finalOutputText(result: unknown): string {
  if (result && typeof result === "object" && "finalOutput" in result) {
    const value = (result as { finalOutput?: unknown }).finalOutput;
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  }

  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

export async function runOpenAiAgentsLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for the OpenAI lane.");
  }

  const recorder = new LaneRunRecorder({
    laneId: "openai",
    runId: context.runId,
    turnId: context.turnId,
    prompt: context.prompt,
    reasoningEffort: context.reasoningEffort,
    modelProvider: "openai",
    modelSize: context.modelSize,
    emit: context.emit,
  });
  recorder.setSession(context.laneSession ?? {});
  const client = createGraphlitClient();
  const tools = createGraphlitTools(client).map((item) =>
    recordGraphlitToolCall(item, recorder),
  );

  try {
    logOpenAiLane("sdk.import.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "openai",
      event: { phase: "openai.sdk.import.start" },
    });
    const { Agent, MemorySession, run, tool } = await import("@openai/agents");
    logOpenAiLane("sdk.import.complete", {
      runId: context.runId,
      turnId: context.turnId,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "openai",
      event: { phase: "openai.sdk.import.complete" },
    });
    const openAiSessionId =
      context.laneSession?.openAiSessionId ?? crypto.randomUUID();
    const session = new MemorySession({
      sessionId: openAiSessionId,
      initialItems: (context.laneSession?.openAiItems ??
        []) as unknown as AgentInputItem[],
    });
    const openaiTools = tools.map((item) =>
      tool({
        name: item.tool.name,
        description: item.tool.description ?? `Run ${item.tool.name}.`,
        parameters: item.inputSchema as never,
        execute: async (args: unknown) =>
          item.handler(args, undefined, context.abortSignal),
      }),
    );
    const agent = new Agent({
      name: "Graphlit Knowledge Agent",
      model: OPENAI_MODELS[context.modelSize],
      instructions: SYSTEM_PROMPT,
      tools: openaiTools,
      modelSettings: {
        reasoning: {
          effort: context.reasoningEffort,
        },
      } as never,
    });
    logOpenAiLane("run.start", {
      runId: context.runId,
      turnId: context.turnId,
      model: OPENAI_MODELS[context.modelSize],
      toolCount: openaiTools.length,
      sessionId: openAiSessionId,
    });
    const result = await run(agent, context.prompt, {
      session,
      maxTurns: 8,
      signal: context.abortSignal,
    });
    logOpenAiLane("run.complete", {
      runId: context.runId,
      turnId: context.turnId,
      sessionId: openAiSessionId,
    });
    const openAiItems = safeJson(await session.getItems());
    recorder.mergeSession({
      openAiSessionId,
      openAiItems: Array.isArray(openAiItems) ? openAiItems : [],
    });
    recorder.recordRaw(result);
    await recorder.emitSnapshot(finalOutputText(result));

    return recorder.result();
  } catch (error) {
    logOpenAiLane("run.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: errorMessage(error),
    });
    return recorder.result(errorMessage(error));
  }
}
