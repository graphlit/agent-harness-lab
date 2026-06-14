import "server-only";

import {
  AGENT_MAX_STEPS,
  ANALYZE_PROMPT_TOOL_NAME,
  MODEL_PROVIDER_MODEL_IDS,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import { emitTextStream } from "@/lib/lanes/streaming";
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

type LangGraphToolChoice =
  | string
  | "any"
  | {
      type: "allowed_tools";
      mode: "required";
      tools: Array<{ type: "function"; name: string }>;
    };

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

function aggregateLangGraphUsage(messages: BaseMessage[]): unknown {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;

  for (const message of messages) {
    const usage = (message as {
      usage_metadata?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
    }).usage_metadata;

    if (!usage) {
      continue;
    }

    hasUsage = true;
    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
    totalTokens +=
      usage.total_tokens ??
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }

  return hasUsage
    ? {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
      }
    : undefined;
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(safeJson(result)) ?? String(result ?? "");
}

function requiredFirstLangGraphToolChoice(
  modelProvider: LaneRunContext["modelProvider"],
  toolName: string,
): LangGraphToolChoice {
  if (modelProvider === "openai") {
    return {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: toolName }],
    };
  }

  return toolName;
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
  const graphlitTools = createGraphlitTools(client).map((graphlitTool) =>
    recordGraphlitToolCall(graphlitTool, recorder),
  );
  const instructions = mergeAgentInstructions(
    context.systemPrompt,
    context.runtimeInstructions,
  );

  try {
    logLangGraphLane("sdk.import.start", {
      runId: context.runId,
      turnId: context.turnId,
    });
    recorder.recordPhase("langgraph.sdk.import.start");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "langgraph",
      event: { phase: "langgraph.sdk.import.start" },
    });
    const [
      { createAgent, createMiddleware },
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
    recorder.recordPhase("langgraph.sdk.import.complete");
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
    let modelCallCount = 0;
    let toolCallCount = 0;
    const requiredFirstToolMiddleware = createMiddleware({
      name: "RequiredFirstGraphlitToolCall",
      wrapModelCall: async (request, handler) => {
        const isFirstModelCall = modelCallCount === 0;

        modelCallCount += 1;

        if (!isFirstModelCall || langGraphTools.length === 0) {
          return handler(request);
        }

        return handler({
          ...request,
          toolChoice: requiredFirstLangGraphToolChoice(
            context.modelProvider,
            ANALYZE_PROMPT_TOOL_NAME,
          ) as never,
        });
      },
      wrapToolCall: async (request, handler) => {
        if (toolCallCount === 0) {
          const toolName = request.toolCall.name;

          if (toolName !== ANALYZE_PROMPT_TOOL_NAME) {
            throw new Error(
              `First LangGraph tool call must be ${ANALYZE_PROMPT_TOOL_NAME}; got ${toolName}.`,
            );
          }
        }

        toolCallCount += 1;

        return handler(request);
      },
    });
    const agent = createAgent({
      name: "graphlit-knowledge-agent",
      model,
      tools: langGraphTools,
      systemPrompt: instructions,
      middleware: [requiredFirstToolMiddleware],
    });

    recorder.mergeSession({ langGraphThreadId: threadId });
    logLangGraphLane("stream.start", {
      runId: context.runId,
      turnId: context.turnId,
      model: modelId,
      modelProvider: context.modelProvider,
      threadId,
      toolCount: langGraphTools.length,
    });
    recorder.recordPhase("langgraph.stream.start", {
      model: modelId,
      modelProvider: context.modelProvider,
      threadId,
      toolCount: langGraphTools.length,
      toolChoice: "analyze_prompt_first",
      streaming: {
        api: "createAgent().streamEvents().messages[].text",
        cadence: "native",
      },
    });
    const run = await agent.streamEvents(
      { messages },
      {
        version: "v3",
        configurable: { thread_id: threadId },
        recursionLimit: AGENT_MAX_STEPS * 2,
        signal: context.abortSignal,
      },
    );

    for await (const message of run.messages) {
      await emitTextStream(message.text, recorder);
    }

    const result = await run.output;
    logLangGraphLane("stream.complete", {
      runId: context.runId,
      turnId: context.turnId,
      threadId,
    });
    recorder.recordPhase("langgraph.stream.complete", {
      threadId,
    });

    const resultMessages = Array.isArray(result.messages)
      ? (result.messages as BaseMessage[])
      : [];
    const currentTurnMessages = resultMessages.slice(messages.length);
    const storedMessages = mapChatMessagesToStoredMessages(resultMessages);
    recorder.mergeSession({
      langGraphThreadId: threadId,
      langGraphMessages: serializableStoredMessages(storedMessages),
    });
    recorder.recordTokenUsage(
      aggregateLangGraphUsage(currentTurnMessages),
      "LangGraph current turn usage",
    );
    recorder.recordRaw(
      safeJson({
        output: result,
        streaming: {
          api: "createAgent().streamEvents().messages[].text",
          cadence: "native",
        },
      }),
    );

    if (!recorder.getAnswer()) {
      await recorder.emitSnapshot(finalLangGraphText(result));
    }

    return recorder.result();
  } catch (error) {
    logLangGraphLane("stream.failed", {
      runId: context.runId,
      turnId: context.turnId,
      error: errorMessage(error),
    });
    return recorder.result(errorMessage(error));
  }
}
