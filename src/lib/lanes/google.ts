import "server-only";

import {
  ANALYZE_PROMPT_TOOL_NAME,
  DEFAULT_MODEL_TEMPERATURE,
  GOOGLE_MODELS,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolsWithRequiredFirst } from "@/lib/tools/recordTool";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

type GoogleSessionService = {
  getOrCreateSession: (request: {
    appName: string;
    userId: string;
    sessionId?: string;
    state?: Record<string, unknown>;
  }) => Promise<unknown>;
};

type GoogleRunner = {
  runAsync: (params: {
    userId: string;
    sessionId: string;
    newMessage: { role?: string; parts: Array<{ text: string }> };
    abortSignal?: AbortSignal;
  }) => AsyncGenerator<unknown, void, undefined>;
};

type GoogleStructuredEvent = {
  type: string;
  content?: string;
  output?: unknown;
};

type GoogleLlmRequest = {
  config?: Record<string, unknown>;
};

type GoogleUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  seen: boolean;
  eventIds: Set<string>;
};

type GoogleAdkModule = {
  EventType: {
    THOUGHT: string;
    CONTENT: string;
    FINISHED: string;
  };
  FunctionTool: new (input: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (args: unknown) => Promise<unknown>;
  }) => unknown;
  InMemorySessionService: new () => GoogleSessionService;
  LlmAgent: new (input: Record<string, unknown>) => unknown;
  Runner: new (input: {
    agent: unknown;
    appName: string;
    sessionService: GoogleSessionService;
  }) => GoogleRunner;
  stringifyContent: (event: unknown) => string;
  toStructuredEvents: (event: unknown) => GoogleStructuredEvent[];
};

const GOOGLE_APP_NAME = "graphlit-agent-harness-lab";
const GOOGLE_USER_ID = "agent-harness-lab";
let sharedGoogleSessionService: GoogleSessionService | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getGoogleSessionService(
  InMemorySessionService: GoogleAdkModule["InMemorySessionService"],
): GoogleSessionService {
  if (!sharedGoogleSessionService) {
    sharedGoogleSessionService = new InMemorySessionService();
  }

  return sharedGoogleSessionService;
}

function eventText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  return JSON.stringify(value);
}

function createGoogleUsageTotals(): GoogleUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    seen: false,
    eventIds: new Set<string>(),
  };
}

function addGoogleUsage(totals: GoogleUsageTotals, event: unknown): void {
  if (!isRecord(event) || !isRecord(event.usageMetadata)) {
    return;
  }

  const eventId = typeof event.id === "string" ? event.id : undefined;

  if (eventId && totals.eventIds.has(eventId)) {
    return;
  }

  const usage = event.usageMetadata;
  const inputTokens = finiteNumber(usage.promptTokenCount) ?? 0;
  const outputTokens = finiteNumber(usage.candidatesTokenCount) ?? 0;
  const totalTokens =
    finiteNumber(usage.totalTokenCount) ?? inputTokens + outputTokens;

  totals.inputTokens += inputTokens;
  totals.outputTokens += outputTokens;
  totals.totalTokens += totalTokens;
  totals.seen = true;

  if (eventId) {
    totals.eventIds.add(eventId);
  }
}

function requireGoogleFunctionCallConfig(
  config: unknown,
  allowedFunctionNames: string[],
): Record<string, unknown> {
  const currentConfig = isRecord(config) ? config : {};
  const currentToolConfig = isRecord(currentConfig.toolConfig)
    ? currentConfig.toolConfig
    : {};
  const currentFunctionCallingConfig = isRecord(
    currentToolConfig.functionCallingConfig,
  )
    ? currentToolConfig.functionCallingConfig
    : {};

  return {
    ...currentConfig,
    toolConfig: {
      ...currentToolConfig,
      functionCallingConfig: {
        ...currentFunctionCallingConfig,
        mode: "ANY",
        allowedFunctionNames,
      },
    },
  };
}

export async function runGoogleLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required for the Google lane.");
  }

  const recorder = new LaneRunRecorder({
    laneId: "google",
    runId: context.runId,
    turnId: context.turnId,
    prompt: context.prompt,
    reasoningEffort: context.reasoningEffort,
    modelProvider: "google",
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
    recorder.recordPhase("google.sdk.import.start");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "google",
      event: { phase: "google.sdk.import.start" },
    });
    const {
      EventType,
      FunctionTool,
      InMemorySessionService,
      LlmAgent,
      Runner,
      stringifyContent,
      toStructuredEvents,
    } = (await import("@google/adk")) as unknown as GoogleAdkModule;
    recorder.recordPhase("google.sdk.import.complete");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "google",
      event: { phase: "google.sdk.import.complete" },
    });
    const googleSessionId =
      context.laneSession?.googleSessionId ?? crypto.randomUUID();
    const sessionService = getGoogleSessionService(InMemorySessionService);
    const tools = graphlitTools.map(
      (item) =>
        new FunctionTool({
          name: item.tool.name,
          description: item.tool.description ?? `Run ${item.tool.name}.`,
          parameters: item.inputSchema as never,
          execute: async (args: unknown) =>
            item.handler(args, undefined, context.abortSignal),
        }),
    );
    let modelCallCount = 0;
    const requiredFirstToolCallback = ({
      request,
    }: {
      request: GoogleLlmRequest;
    }) => {
      const isFirstModelCall = modelCallCount === 0;

      modelCallCount += 1;

      if (!isFirstModelCall || tools.length === 0) {
        return undefined;
      }

      request.config = requireGoogleFunctionCallConfig(
        request.config,
        [ANALYZE_PROMPT_TOOL_NAME],
      );

      return undefined;
    };
    const agent = new LlmAgent({
      name: "graphlit_knowledge_agent",
      model: GOOGLE_MODELS[context.modelSize],
      instruction: instructions,
      tools,
      includeContents: "default",
      beforeModelCallback: requiredFirstToolCallback,
      generateContentConfig: {
        temperature: DEFAULT_MODEL_TEMPERATURE,
      },
    });
    const runner = new Runner({
      agent,
      appName: GOOGLE_APP_NAME,
      sessionService,
    });
    await sessionService.getOrCreateSession({
      appName: GOOGLE_APP_NAME,
      userId: GOOGLE_USER_ID,
      sessionId: googleSessionId,
    });
    recorder.mergeSession({ googleSessionId });
    recorder.recordPhase("google.runAsync.start", {
      model: GOOGLE_MODELS[context.modelSize],
      sessionId: googleSessionId,
      toolCount: tools.length,
      toolChoice: "analyze_prompt_first",
      streaming: {
        api: "Runner.runAsync",
        cadence: "native",
      },
    });
    let finalText = "";
    const usageTotals = createGoogleUsageTotals();

    for await (const event of runner.runAsync({
      userId: GOOGLE_USER_ID,
      sessionId: googleSessionId,
      newMessage: {
        role: "user",
        parts: [{ text: context.prompt }],
      },
      abortSignal: context.abortSignal,
    })) {
      recorder.recordRaw(event);
      addGoogleUsage(usageTotals, event);

      for (const structured of toStructuredEvents(event)) {
        if (
          structured.type === EventType.THOUGHT &&
          typeof structured.content === "string"
        ) {
          await context.emit({
            type: "lane_reasoning_delta",
            runId: context.runId,
            turnId: context.turnId,
            laneId: "google",
            text: structured.content,
          });
        }

        if (
          structured.type === EventType.CONTENT &&
          typeof structured.content === "string"
        ) {
          await recorder.emitDelta(structured.content);
        }

        if (structured.type === EventType.FINISHED && structured.output) {
          finalText = eventText(structured.output);
        }
      }

      if (!finalText) {
        finalText = stringifyContent(event);
      }
    }

    if (!recorder.getAnswer() && finalText) {
      await recorder.emitSnapshot(finalText);
    }

    recorder.recordPhase("google.runAsync.complete", {
      sessionId: googleSessionId,
    });

    if (usageTotals.seen) {
      recorder.recordTokenUsage(
        {
          inputTokens: usageTotals.inputTokens,
          outputTokens: usageTotals.outputTokens,
          totalTokens: usageTotals.totalTokens,
        },
        "Google ADK current turn usage",
      );
    }

    return recorder.result();
  } catch (error) {
    return recorder.result(errorMessage(error));
  }
}
