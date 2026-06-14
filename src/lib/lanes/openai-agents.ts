import "server-only";

import {
  AGENT_MAX_STEPS,
  ANALYZE_PROMPT_TOOL_NAME,
  OPENAI_MODELS,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { emitTextStream } from "@/lib/lanes/streaming";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage, safeJson } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { toNonStrictJsonSchema } from "@/lib/tools/jsonSchema";
import { recordGraphlitToolsWithRequiredFirst } from "@/lib/tools/recordTool";
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
    if (value == null) {
      return "";
    }

    return typeof value === "string" ? value : JSON.stringify(value);
  }

  if (result == null) {
    return "";
  }

  return typeof result === "string" ? result : JSON.stringify(result);
}

function parseToolArguments(inputSchema: unknown, args: unknown): unknown {
  if (
    inputSchema &&
    typeof inputSchema === "object" &&
    "parse" in inputSchema &&
    typeof inputSchema.parse === "function"
  ) {
    return inputSchema.parse(args);
  }

  return args;
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
  const tools = recordGraphlitToolsWithRequiredFirst(
    createGraphlitTools(client),
    recorder,
    ANALYZE_PROMPT_TOOL_NAME,
  );
  const instructions = mergeAgentInstructions(
    context.systemPrompt,
    context.runtimeInstructions,
  );

  try {
    logOpenAiLane("sdk.import.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("openai.sdk.import.start");
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
    recorder.recordPhase("openai.sdk.import.complete");
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
    const openaiTools = tools.map((item) => {
      const isAnalyzePromptTool = item.tool.name === ANALYZE_PROMPT_TOOL_NAME;

      return tool({
        name: item.tool.name,
        description: item.tool.description ?? `Run ${item.tool.name}.`,
        parameters: (isAnalyzePromptTool
          ? toNonStrictJsonSchema(item.inputSchema)
          : item.inputSchema) as never,
        ...(isAnalyzePromptTool ? { strict: false as const } : {}),
        execute: async (args: unknown) =>
          item.handler(
            parseToolArguments(item.inputSchema, args),
            undefined,
            context.abortSignal,
          ),
      } as never);
    });
    const agent = new Agent({
      name: "Graphlit Knowledge Agent",
      model: OPENAI_MODELS[context.modelSize],
      instructions,
      tools: openaiTools,
      modelSettings: {
        toolChoice: ANALYZE_PROMPT_TOOL_NAME,
        reasoning: {
          effort: context.reasoningEffort,
        },
      } as never,
      resetToolChoice: true,
    });
    logOpenAiLane("run.start", {
      runId: context.runId,
      turnId: context.turnId,
      model: OPENAI_MODELS[context.modelSize],
      toolCount: openaiTools.length,
      sessionId: openAiSessionId,
    });
    recorder.recordPhase("openai.run.start", {
      model: OPENAI_MODELS[context.modelSize],
      toolCount: openaiTools.length,
      toolChoice: "analyze_prompt_first",
      sessionId: openAiSessionId,
      streaming: {
        api: "run(stream: true).toTextStream()",
        cadence: "native",
      },
    });
    const result = await run(agent, context.prompt, {
      session,
      maxTurns: AGENT_MAX_STEPS,
      signal: context.abortSignal,
      stream: true,
    });
    await emitTextStream(result.toTextStream(), recorder);
    await result.completed;
    logOpenAiLane("run.complete", {
      runId: context.runId,
      turnId: context.turnId,
      sessionId: openAiSessionId,
    });
    recorder.recordPhase("openai.run.complete", {
      sessionId: openAiSessionId,
      lastResponseId: result.lastResponseId,
    });
    const openAiItems = safeJson(await session.getItems());
    recorder.mergeSession({
      openAiSessionId,
      openAiItems: Array.isArray(openAiItems) ? openAiItems : [],
    });
    recorder.recordTokenUsage(
      (result as { state?: { usage?: unknown } }).state?.usage,
      "OpenAI Agents run usage",
    );
    recorder.recordRaw(
      safeJson({
        finalOutput: result.finalOutput,
        lastResponseId: result.lastResponseId,
        newItems: result.newItems,
        rawResponses: result.rawResponses,
        usage: (result as { state?: { usage?: unknown } }).state?.usage,
        streaming: {
          api: "run(stream: true).toTextStream()",
          cadence: "native",
        },
      }),
    );

    const resolvedFinalText = finalOutputText(result);

    if (resolvedFinalText && resolvedFinalText !== recorder.getAnswer()) {
      await recorder.emitSnapshot(resolvedFinalText);
    }

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
