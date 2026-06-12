import "server-only";

import { MODEL_PROVIDER_MODEL_IDS } from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
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
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";

function logLangGraphLane(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/lane/langgraph] ${phase}`, details ?? {});
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }

        return "";
      })
      .filter(Boolean)
      .join("");
  }

  return "";
}

function finalLangGraphText(result: unknown): string {
  if (result && typeof result === "object") {
    const messages = (result as { messages?: unknown }).messages;

    if (Array.isArray(messages)) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {
          type?: unknown;
          text?: unknown;
          content?: unknown;
        };

        if (message.type !== "ai" && message.type !== "assistant") {
          continue;
        }

        if (typeof message.text === "string" && message.text.trim()) {
          return message.text;
        }

        const text = contentText(message.content);

        if (text.trim()) {
          return text;
        }
      }
    }

    if (
      "content" in result &&
      typeof (result as { content?: unknown }).content === "string"
    ) {
      return (result as { content: string }).content;
    }
  }

  return typeof result === "string" ? result : JSON.stringify(safeJson(result));
}

function storedLangGraphMessages(session?: LaneSessionState): StoredMessage[] {
  const messages = session?.langGraphMessages;

  return Array.isArray(messages) ? (messages as unknown as StoredMessage[]) : [];
}

function serializableStoredMessages(messages: StoredMessage[]): JsonValue[] {
  const value = safeJson(messages);

  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(safeJson(result)) ?? String(result ?? "");
}

export async function runLangGraphLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  const recorder = new LaneRunRecorder({
    laneId: "langgraph",
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
    logLangGraphLane("sdk.import.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "langgraph",
      event: { phase: "langgraph.sdk.import.start" },
    });
    const [
      { createAgent },
      { tool },
      {
        HumanMessage,
        mapChatMessagesToStoredMessages,
        mapStoredMessagesToChatMessages,
      },
    ] = await Promise.all([
      import("langchain"),
      import("@langchain/core/tools"),
      import("@langchain/core/messages"),
    ]);
    logLangGraphLane("sdk.import.complete", {
      runId: context.runId,
      turnId: context.turnId,
    });
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "langgraph",
      event: { phase: "langgraph.sdk.import.complete" },
    });

    const langGraphTools = graphlitTools.map((item) =>
      tool(
        async (args: unknown, options?: { signal?: AbortSignal }) =>
          toolResultText(
            await item.handler(
              args,
              undefined,
              options?.signal ?? context.abortSignal,
            ),
          ),
        {
          name: item.tool.name,
          description: item.tool.description ?? `Run ${item.tool.name}.`,
          schema: item.inputSchema as never,
        },
      ),
    );
    const threadId =
      context.laneSession?.langGraphThreadId ?? crypto.randomUUID();
    const previousMessages = mapStoredMessagesToChatMessages(
      storedLangGraphMessages(context.laneSession),
    );
    const messages = [...previousMessages, new HumanMessage(context.prompt)];
    const modelId = MODEL_PROVIDER_MODEL_IDS[context.modelProvider][
      context.modelSize
    ];
    const model = await (async () => {
      if (context.modelProvider === "anthropic") {
        const { ChatAnthropic } = await import("@langchain/anthropic");

        return new ChatAnthropic({
          model: modelId,
          apiKey: requireModelProviderApiKey(
            "anthropic",
            "the LangGraph lane",
          ),
        });
      }

      if (context.modelProvider === "google") {
        const { ChatGoogleGenerativeAI } = await import(
          "@langchain/google-genai"
        );

        return new ChatGoogleGenerativeAI({
          model: modelId,
          apiKey: requireModelProviderApiKey("google", "the LangGraph lane"),
        });
      }

      const { ChatOpenAI } = await import("@langchain/openai");

      return new ChatOpenAI({
        model: modelId,
        apiKey: requireModelProviderApiKey("openai", "the LangGraph lane"),
        useResponsesApi: true,
        reasoning: {
          effort: context.reasoningEffort,
        },
      });
    })();
    const agent = createAgent({
      name: "graphlit-knowledge-agent",
      model,
      tools: langGraphTools,
      systemPrompt: context.systemPrompt,
    });

    recorder.mergeSession({ langGraphThreadId: threadId });
    logLangGraphLane("invoke.start", {
      runId: context.runId,
      turnId: context.turnId,
      model: modelId,
      modelProvider: context.modelProvider,
      threadId,
      toolCount: langGraphTools.length,
    });
    const result = await agent.invoke(
      { messages },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 16,
        signal: context.abortSignal,
      },
    );
    logLangGraphLane("invoke.complete", {
      runId: context.runId,
      turnId: context.turnId,
      threadId,
    });

    const resultMessages = Array.isArray(result.messages)
      ? (result.messages as BaseMessage[])
      : [];
    const storedMessages = mapChatMessagesToStoredMessages(resultMessages);
    recorder.mergeSession({
      langGraphThreadId: threadId,
      langGraphMessages: serializableStoredMessages(storedMessages),
    });
    recorder.recordRaw(safeJson(result));
    await recorder.emitSnapshot(finalLangGraphText(result));

    return recorder.result();
  } catch (error) {
    logLangGraphLane("invoke.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: errorMessage(error),
    });
    return recorder.result(errorMessage(error));
  }
}
