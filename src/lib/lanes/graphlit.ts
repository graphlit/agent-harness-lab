import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { AgentStreamEvent } from "graphlit-client";

import {
  AGENT_MAX_STEPS,
  ANALYZE_PROMPT_TOOL_NAME,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { requireModelProviderApiKey } from "@/lib/model-provider-keys";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import {
  recordGraphlitToolsWithRequiredFirst,
  toStreamAgentToolHandlers,
} from "@/lib/tools/recordTool";

const GRAPHLIT_MESSAGE_PREVIEW_CHARS = 240;

type GraphlitUsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  seen: boolean;
};
type GraphlitCompletedUsage = Extract<
  AgentStreamEvent,
  { type: "conversation_completed" }
>["usage"];
type GraphlitAnswerSegment = {
  latestFullText: string;
  segmentStart: number;
  sawToolBoundary: boolean;
  lastEmittedText: string;
};

function createGraphlitAnswerSegment(): GraphlitAnswerSegment {
  return {
    latestFullText: "",
    segmentStart: 0,
    sawToolBoundary: false,
    lastEmittedText: "",
  };
}

function createGraphlitUsageTotals(): GraphlitUsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    seen: false,
  };
}

function addGraphlitUsage(
  totals: GraphlitUsageTotals,
  usage: GraphlitCompletedUsage,
): void {
  if (!usage) {
    return;
  }

  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
  totals.seen = true;
}

function readMessage(event: AgentStreamEvent): { text?: string } {
  if (event.type !== "message_update") {
    return {};
  }

  const message = event.message;
  const text = message?.message ?? "";

  return { text };
}

function visibleGraphlitAnswerText(
  segment: GraphlitAnswerSegment,
  text: string,
): string {
  if (!segment.sawToolBoundary) {
    return text;
  }

  return text.slice(Math.min(segment.segmentStart, text.length)).trimStart();
}

function resetGraphlitAnswerSegment(
  segment: GraphlitAnswerSegment,
  event: AgentStreamEvent,
): { changed: boolean; toolName?: string; status?: string } {
  if (event.type !== "tool_update") {
    return { changed: false };
  }

  const previousStart = segment.segmentStart;
  const previousSawToolBoundary = segment.sawToolBoundary;

  segment.sawToolBoundary = true;
  segment.segmentStart = segment.latestFullText.length;

  return {
    changed:
      !previousSawToolBoundary || previousStart !== segment.segmentStart,
    toolName: event.toolCall?.name ?? undefined,
    status: event.status,
  };
}

function compactGraphlitStreamEvent(event: AgentStreamEvent): unknown {
  if (event.type !== "message_update") {
    return event;
  }

  const message = event.message;
  const text = message?.message ?? "";

  return {
    type: event.type,
    isStreaming: event.isStreaming,
    metrics: event.metrics,
    message: {
      role: message?.role,
      timestamp: message?.timestamp,
      model: message?.model,
      modelName: message?.modelName,
      modelService: message?.modelService,
      isThinking: message?.isThinking,
      messageChars: text.length,
      messagePreview:
        text.length > GRAPHLIT_MESSAGE_PREVIEW_CHARS
          ? `${text.slice(0, GRAPHLIT_MESSAGE_PREVIEW_CHARS)}...`
          : text,
    },
  };
}

function readReasoning(event: AgentStreamEvent): string {
  if (event.type !== "reasoning_update" || !("content" in event)) {
    return "";
  }

  return typeof event.content === "string" ? event.content : "";
}

function logGraphlitLane(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/lane/graphlit] ${phase}`, details ?? {});
}

export async function runGraphlitLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  if (!context.graphlitSpecification?.id) {
    throw new Error("Graphlit lane is missing a bootstrapped specification.");
  }

  const recorder = new LaneRunRecorder({
    laneId: "graphlit",
    runId: context.runId,
    turnId: context.turnId,
    prompt: context.prompt,
    reasoningEffort: context.reasoningEffort,
    modelProvider: context.modelProvider,
    modelSize: context.modelSize,
    emit: context.emit,
  });
  recorder.setSession(context.laneSession ?? {});
  let conversationId = context.laneSession?.graphlitConversationId;
  logGraphlitLane("client.create", {
    runId: context.runId,
    turnId: context.turnId,
    specificationId: context.graphlitSpecification.id,
    continuingConversation: Boolean(conversationId),
  });
  await context.emit({
    type: "lane_trace",
    runId: context.runId,
    turnId: context.turnId,
    laneId: "graphlit",
    event: {
      phase: "graphlit.client.create",
      specificationId: context.graphlitSpecification.id,
      modelProvider: context.modelProvider,
      continuingConversation: Boolean(conversationId),
    },
  });
  const client = createGraphlitClient();

  if (context.modelProvider === "anthropic") {
    client.setAnthropicClient(
      new Anthropic({
        apiKey: requireModelProviderApiKey("anthropic", "the Graphlit lane"),
      }),
    );
  } else if (context.modelProvider === "google") {
    client.setGoogleClient(
      new GoogleGenAI({
        apiKey: requireModelProviderApiKey("google", "the Graphlit lane"),
      }),
    );
  } else {
    client.setOpenAIClient(
      new OpenAI({
        apiKey: requireModelProviderApiKey("openai", "the Graphlit lane"),
      }),
    );
  }

  const tools = recordGraphlitToolsWithRequiredFirst(
    createGraphlitTools(client),
    recorder,
    ANALYZE_PROMPT_TOOL_NAME,
  );
  const toolHandlers = toStreamAgentToolHandlers(tools);
  const instructions = mergeAgentInstructions(
    context.systemPrompt,
    context.runtimeInstructions,
  );
  let lastThinkingSnapshot = "";
  const usageTotals = createGraphlitUsageTotals();
  const answerSegment = createGraphlitAnswerSegment();

  function thinkingDelta(snapshot: string): string {
    if (!snapshot || snapshot === lastThinkingSnapshot) {
      return "";
    }

    const delta = snapshot.startsWith(lastThinkingSnapshot)
      ? snapshot.slice(lastThinkingSnapshot.length)
      : snapshot;

    lastThinkingSnapshot = snapshot;

    return delta;
  }

  function emitGraphlitAnswerSnapshot(text: string): void {
    if (text === answerSegment.lastEmittedText) {
      return;
    }

    answerSegment.lastEmittedText = text;
    void recorder.emitSnapshot(text);
  }

  try {
    const startEvent = {
      phase: "graphlit.streamAgent.start",
      specificationId: context.graphlitSpecification.id,
      conversationId,
      modelProvider: context.modelProvider,
      toolCount: tools.length,
      streaming: {
        api: "streamAgent",
        cadence: "sentence",
      },
    };

    recorder.recordRaw(startEvent);
    logGraphlitLane("streamAgent.start", {
      runId: context.runId,
      turnId: context.turnId,
      specificationId: context.graphlitSpecification.id,
      conversationId,
      modelProvider: context.modelProvider,
      toolCount: tools.length,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "graphlit",
      event: startEvent,
    });

    await client.streamAgent(
      context.prompt,
      (event) => {
        recorder.recordRaw(compactGraphlitStreamEvent(event));
        logGraphlitLane("streamAgent.event", {
          runId: context.runId,
          turnId: context.turnId,
          eventType: event.type,
        });

        const segmentReset = resetGraphlitAnswerSegment(answerSegment, event);

        if (segmentReset.changed) {
          recorder.recordPhase("graphlit.answer_segment.reset", {
            toolName: segmentReset.toolName,
            status: segmentReset.status,
            fullTextChars: answerSegment.latestFullText.length,
          });
          emitGraphlitAnswerSnapshot(
            visibleGraphlitAnswerText(
              answerSegment,
              answerSegment.latestFullText,
            ),
          );
        }

        if (
          event.type === "conversation_started" &&
          "conversationId" in event &&
          typeof event.conversationId === "string"
        ) {
          conversationId = event.conversationId;
          recorder.mergeSession({ graphlitConversationId: conversationId });
        }

        if (event.type === "message_update") {
          const { text } = readMessage(event);

          if (typeof text === "string") {
            answerSegment.latestFullText = text;
            emitGraphlitAnswerSnapshot(
              visibleGraphlitAnswerText(answerSegment, text),
            );
          }
        }

        if (event.type === "reasoning_update") {
          const delta = thinkingDelta(readReasoning(event));

          if (delta) {
            void context.emit({
              type: "lane_reasoning_delta",
              runId: context.runId,
              turnId: context.turnId,
              laneId: "graphlit",
              text: delta,
            });
          }
        }

        if (event.type === "conversation_completed") {
          const finalMessage = event.message?.message;

          if (typeof finalMessage === "string" && finalMessage.length > 0) {
            recorder.setAnswer(
              visibleGraphlitAnswerText(answerSegment, finalMessage),
            );
          }

          addGraphlitUsage(usageTotals, event.usage);
        }

        if (event.type === "error") {
          const maybeError = "error" in event ? event.error : undefined;
          recorder.recordRaw({
            type: "graphlit_error",
            message:
              maybeError instanceof Error ? maybeError.message : maybeError,
          });
        }
      },
      conversationId,
      { id: context.graphlitSpecification.id },
      tools.map((tool) => tool.tool),
      toolHandlers,
      {
        chunkingStrategy: "sentence",
        useResponsesApi: true,
        maxToolRounds: AGENT_MAX_STEPS,
        abortSignal: context.abortSignal,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      instructions,
    );
    const completeEvent = {
      phase: "graphlit.streamAgent.complete",
      conversationId,
    };

    recorder.recordRaw(completeEvent);
    logGraphlitLane("streamAgent.complete", {
      runId: context.runId,
      turnId: context.turnId,
      conversationId,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "graphlit",
      event: completeEvent,
    });

    if (usageTotals.seen) {
      recorder.recordTokenUsage(
        usageTotals,
        "Graphlit aggregated current turn usage",
      );
    }

    return recorder.result();
  } catch (error) {
    logGraphlitLane("streamAgent.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: errorMessage(error),
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "graphlit",
      event: {
        phase: "graphlit.streamAgent.failed",
        error: errorMessage(error),
      },
    });
    return recorder.result(errorMessage(error));
  }
}
