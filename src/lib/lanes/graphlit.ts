import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { AgentStreamEvent } from "graphlit-client";

import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { requireModelProviderApiKey } from "@/lib/model-provider-keys";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import {
  recordGraphlitToolCall,
  toStreamAgentToolHandlers,
} from "@/lib/tools/recordTool";

function readMessage(event: AgentStreamEvent): {
  text?: string;
  thinking?: string;
} {
  if (event.type !== "message_update") {
    return {};
  }

  const message = event.message;
  const text = message?.message ?? "";

  if (message?.isThinking) {
    return { thinking: text };
  }

  return { text };
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

  const tools = createGraphlitTools(client).map((tool) =>
    recordGraphlitToolCall(tool, recorder),
  );
  const toolHandlers = toStreamAgentToolHandlers(tools);

  try {
    const startEvent = {
      phase: "graphlit.streamAgent.start",
      specificationId: context.graphlitSpecification.id,
      conversationId,
      modelProvider: context.modelProvider,
      toolCount: tools.length,
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
        recorder.recordRaw(event);
        logGraphlitLane("streamAgent.event", {
          runId: context.runId,
          turnId: context.turnId,
          eventType: event.type,
        });

        if (
          event.type === "conversation_started" &&
          "conversationId" in event &&
          typeof event.conversationId === "string"
        ) {
          conversationId = event.conversationId;
          recorder.mergeSession({ graphlitConversationId: conversationId });
        }

        if (event.type === "message_update") {
          const { text, thinking } = readMessage(event);

          if (thinking) {
            void context.emit({
              type: "lane_reasoning_delta",
              runId: context.runId,
              turnId: context.turnId,
              laneId: "graphlit",
              text: thinking,
            });
          } else if (typeof text === "string") {
            void recorder.emitSnapshot(text);
          }
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
        chunkingStrategy: "word",
        useResponsesApi: true,
        maxToolRounds: 8,
        abortSignal: context.abortSignal,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      context.systemPrompt,
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
