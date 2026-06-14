import "server-only";

import type {
  AnyZodRawShape,
  CanUseTool,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

import {
  AGENT_MAX_STEPS,
  ANALYZE_PROMPT_TOOL_NAME,
  CLAUDE_MODELS,
  mergeAgentInstructions,
} from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import { LaneRunRecorder } from "@/lib/lanes/recorder";
import type { LaneRunContext, LaneRunResult } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { createGraphlitTools } from "@/lib/tools/createGraphlitTools";
import { recordGraphlitToolsWithRequiredFirst } from "@/lib/tools/recordTool";
import { getZodRawShape } from "@/lib/tools/types";

function extractClaudeText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (
    "type" in message &&
    message.type === "result" &&
    "subtype" in message &&
    message.subtype === "success" &&
    "result" in message
  ) {
    return typeof message.result === "string"
      ? message.result
      : JSON.stringify(message.result ?? "");
  }

  if ("message" in message && typeof message.message === "object") {
    return extractClaudeText(message.message);
  }

  if ("content" in message && Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (item && typeof item === "object" && "text" in item) {
          return typeof item.text === "string" ? item.text : "";
        }

        return "";
      })
      .join("");
  }

  return "";
}

function extractClaudePartial(message: unknown): {
  text?: string;
  thinking?: string;
} {
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "stream_event" ||
    !("event" in message) ||
    !message.event ||
    typeof message.event !== "object"
  ) {
    return {};
  }

  const event = message.event as {
    type?: unknown;
    delta?: {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
    };
  };

  if (event.type !== "content_block_delta") {
    return {};
  }

  if (
    event.delta?.type === "text_delta" &&
    typeof event.delta.text === "string"
  ) {
    return { text: event.delta.text };
  }

  if (
    event.delta?.type === "thinking_delta" &&
    typeof event.delta.thinking === "string"
  ) {
    return { thinking: event.delta.thinking };
  }

  return {};
}

function structuredToolContent(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }

  return { result };
}

function readClaudeSessionId(message: unknown): string | undefined {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "system" &&
    "subtype" in message &&
    message.subtype === "init" &&
    "session_id" in message &&
    typeof message.session_id === "string"
  ) {
    return message.session_id;
  }

  return undefined;
}

export async function runClaudeLane(
  context: LaneRunContext,
): Promise<LaneRunResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for the Claude lane.");
  }

  const recorder = new LaneRunRecorder({
    laneId: "claude",
    runId: context.runId,
    turnId: context.turnId,
    prompt: context.prompt,
    reasoningEffort: context.reasoningEffort,
    modelProvider: "anthropic",
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
    recorder.recordPhase("claude.sdk.import.start");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "claude",
      event: { phase: "claude.sdk.import.start" },
    });
    const { createSdkMcpServer, query, tool } = await import(
      "@anthropic-ai/claude-agent-sdk"
    );
    recorder.recordPhase("claude.sdk.import.complete");
    await context.emit({
      type: "lane_trace",
      runId: context.runId,
      turnId: context.turnId,
      laneId: "claude",
      event: { phase: "claude.sdk.import.complete" },
    });
    const claudeTools: SdkMcpToolDefinition[] = graphlitTools.map((item) =>
      tool(
        item.tool.name,
        item.tool.description ?? `Run ${item.tool.name}.`,
        getZodRawShape(item.inputSchema) as AnyZodRawShape,
        async (args: unknown) => {
          const result = await item.handler(
            args,
            undefined,
            context.abortSignal,
          );

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: structuredToolContent(result),
          };
        },
        { annotations: { readOnlyHint: true, openWorldHint: true } },
      ),
    );
    const graphlitServer = createSdkMcpServer({
      name: "graphlit",
      version: "1.0.0",
      tools: claudeTools,
    });
    const agentName = "graphlit-knowledge-agent";
    const allowedTools = graphlitTools.map(
      (item) => `mcp__graphlit__${item.tool.name}`,
    );
    const analyzePromptMcpToolName = `mcp__graphlit__${ANALYZE_PROMPT_TOOL_NAME}`;
    let firstGraphlitToolSeen = false;
    const canUseGraphlitTool: CanUseTool = async (
      toolName,
      _input,
      options,
    ) => {
      if (toolName.startsWith("mcp__graphlit__") && !firstGraphlitToolSeen) {
        if (toolName !== analyzePromptMcpToolName) {
          return {
            behavior: "deny",
            message: `The first Graphlit tool call for this turn must be ${analyzePromptMcpToolName}.`,
            toolUseID: options.toolUseID,
          };
        }

        firstGraphlitToolSeen = true;
      }

      return {
        behavior: "allow",
        toolUseID: options.toolUseID,
      };
    };
    const claudeInstructions = mergeAgentInstructions(
      instructions,
      allowedTools.length > 0
        ? `Harness parity requirement: at the start of each new user request, call ${analyzePromptMcpToolName} before any other Graphlit MCP tool or final answer. After that first tool call, continue with more tool calls only when they materially improve the answer.`
        : undefined,
    );
    const requestedSessionId =
      context.laneSession?.claudeSessionId ?? crypto.randomUUID();
    let claudeSessionId = context.laneSession?.claudeSessionId;
    let finalText = "";

    recorder.recordPhase("claude.query.start", {
      model: CLAUDE_MODELS[context.modelSize],
      sessionId: requestedSessionId,
      toolCount: claudeTools.length,
      toolChoice: "analyze_prompt_first",
      streaming: {
        api: "query(includePartialMessages: true)",
        cadence: "partial",
      },
    });

    for await (const message of query({
      prompt: context.prompt,
      options: {
        agent: agentName,
        agents: {
          [agentName]: {
            description:
              "Answers questions using Graphlit retrieval and source inspection tools.",
            ...(claudeInstructions ? { prompt: claudeInstructions } : {}),
            tools: allowedTools,
            model: CLAUDE_MODELS[context.modelSize],
            effort: context.reasoningEffort,
            maxTurns: AGENT_MAX_STEPS,
            permissionMode: "dontAsk",
          },
        },
        model: CLAUDE_MODELS[context.modelSize],
        mcpServers: { graphlit: graphlitServer },
        tools: [],
        allowedTools,
        canUseTool: canUseGraphlitTool,
        maxTurns: AGENT_MAX_STEPS,
        permissionMode: "dontAsk",
        effort: context.reasoningEffort,
        includePartialMessages: true,
        ...(claudeSessionId
          ? { resume: claudeSessionId }
          : { sessionId: requestedSessionId }),
      },
    } as never)) {
      recorder.recordRaw(message);
      const partial = extractClaudePartial(message);

      if (partial.thinking) {
        await context.emit({
          type: "lane_reasoning_delta",
          runId: context.runId,
          turnId: context.turnId,
          laneId: "claude",
          text: partial.thinking,
        });
      }

      if (partial.text) {
        finalText += partial.text;
        await recorder.emitDelta(partial.text);
      }

      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "result" &&
        "usage" in message
      ) {
        recorder.recordTokenUsage(
          message,
          "Claude Agent SDK result turn weight",
        );
      }
      claudeSessionId = readClaudeSessionId(message) ?? claudeSessionId;
      const text = extractClaudeText(message);

      if (text && text !== recorder.getAnswer()) {
        finalText = text;
        await recorder.emitSnapshot(finalText);
      }
    }

    if (!recorder.getAnswer() && finalText) {
      await recorder.emitSnapshot(finalText);
    }

    recorder.mergeSession({
      claudeSessionId: claudeSessionId ?? requestedSessionId,
    });
    recorder.recordPhase("claude.query.complete", {
      sessionId: claudeSessionId ?? requestedSessionId,
    });

    return recorder.result();
  } catch (error) {
    return recorder.result(errorMessage(error));
  }
}
