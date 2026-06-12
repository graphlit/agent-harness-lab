import "server-only";

import {
  GOOGLE_MODELS,
  SYSTEM_PROMPT,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolCall } from "@/lib/tools/recordTool";
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
  const graphlitTools = createGraphlitTools(client).map((item) =>
    recordGraphlitToolCall(item, recorder),
  );

  try {
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
    const agent = new LlmAgent({
      name: "graphlit_knowledge_agent",
      model: GOOGLE_MODELS[context.modelSize],
      instruction: SYSTEM_PROMPT,
      tools,
      includeContents: "default",
      generateContentConfig: {
        temperature: 0.2,
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
    let finalText = "";

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

    return recorder.result();
  } catch (error) {
    return recorder.result(errorMessage(error));
  }
}
