import {
  DEFAULT_MODEL_PROVIDER,
  LANE_LABELS,
  LANE_STREAM_LABELS,
  getLaneModelLabel,
  titleCaseEffort,
} from "@/lib/constants";
import type {
  LaneId,
  LaneRunResult,
  LaneSessionState,
  ModelProviderPreference,
  ModelSize,
  ReasoningEffort,
  RunEventEmitter,
  SourceTrace,
  ToolCallTrace,
  TokenUsageTrace,
} from "@/lib/types";
import { elapsedMs, nowIso, summarizeJson } from "@/lib/utils";

type RetrieveResultLike = {
  results?: Array<{
    id?: string;
    resourceUri?: string;
    name?: string;
    text?: string;
    relevance?: number | null;
  }>;
};

type InspectResultLike = {
  id?: string;
  resourceUri?: string;
  name?: string;
  text?: string;
};

type InspectPageResultLike = {
  url?: string;
  text?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numericField(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const item = finiteNumber(value[key]);

    if (item !== undefined) {
      return item;
    }
  }

  return undefined;
}

function normalizeTokenUsage(
  value: unknown,
  source: string,
): TokenUsageTrace | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage = isRecord(value.usage) ? value.usage : value;
  const baseInputTokens = numericField(usage, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "promptTokenCount",
    "prompt_token_count",
  ]);
  const anthropicCacheInputTokens = numericField(usage, [
    "cache_creation_input_tokens",
  ]);
  const anthropicCacheReadTokens = numericField(usage, [
    "cache_read_input_tokens",
  ]);
  const inputTokens =
    baseInputTokens === undefined
      ? undefined
      : baseInputTokens +
        (anthropicCacheInputTokens ?? 0) +
        (anthropicCacheReadTokens ?? 0);
  const outputTokens = numericField(usage, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "candidatesTokenCount",
    "candidates_token_count",
  ]);
  const totalFields = [
    "totalTokens",
    "total_tokens",
    "totalTokenCount",
    "total_token_count",
    "total_tokens_count",
  ];
  const reportedTotal =
    numericField(value, totalFields) ?? numericField(usage, totalFields);
  const computedTotal =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  const totalTokens = reportedTotal ?? computedTotal;

  if (totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source,
  };
}

export class LaneRunRecorder {
  readonly laneId: LaneId;
  readonly runId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly modelProvider: ModelProviderPreference;
  readonly modelSize: ModelSize;
  readonly startedAt = nowIso();

  private readonly emit: RunEventEmitter;
  private readonly toolCalls = new Map<string, ToolCallTrace>();
  private readonly sources = new Map<string, SourceTrace>();
  private readonly rawEvents: unknown[] = [];
  private session: LaneSessionState = {};
  private finalAnswer = "";
  private tokenUsage: TokenUsageTrace | undefined;

  constructor(options: {
    laneId: LaneId;
    runId: string;
    turnId: string;
    prompt: string;
    reasoningEffort: ReasoningEffort;
    modelProvider?: ModelProviderPreference;
    modelSize: ModelSize;
    emit: RunEventEmitter;
  }) {
    this.laneId = options.laneId;
    this.runId = options.runId;
    this.turnId = options.turnId;
    this.prompt = options.prompt;
    this.reasoningEffort = options.reasoningEffort;
    this.modelProvider = options.modelProvider ?? DEFAULT_MODEL_PROVIDER;
    this.modelSize = options.modelSize;
    this.emit = options.emit;
    this.rawEvents.push(
      this.createTelemetryEvent("lane.started", this.startedAt, {
        modelLabel: getLaneModelLabel(
          this.laneId,
          this.modelSize,
          this.modelProvider,
        ),
        reasoningEffort: this.reasoningEffort,
        modelProvider: this.modelProvider,
        modelSize: this.modelSize,
        streaming: LANE_STREAM_LABELS[this.laneId],
      }),
    );
  }

  recordRaw(event: unknown): void {
    this.rawEvents.push(event);
  }

  recordPhase(phase: string, details: Record<string, unknown> = {}): void {
    this.rawEvents.push(this.createTelemetryEvent(phase, nowIso(), details));
  }

  recordTokenUsage(usage: unknown, source: string): void {
    const normalized = normalizeTokenUsage(usage, source);

    if (normalized) {
      this.tokenUsage = normalized;
      this.rawEvents.push(
        this.createTelemetryEvent("usage.reported", nowIso(), {
          tokenUsage: normalized,
        }),
      );
    }
  }

  setSession(session: LaneSessionState): void {
    this.session = { ...session };
  }

  mergeSession(session: LaneSessionState): void {
    this.session = { ...this.session, ...session };
  }

  appendAnswer(text: string): void {
    this.finalAnswer += text;
  }

  setAnswer(text: string): void {
    this.finalAnswer = text;
  }

  getAnswer(): string {
    return this.finalAnswer;
  }

  hasVisibleActivity(): boolean {
    return this.finalAnswer.trim().length > 0 || this.toolCalls.size > 0;
  }

  async emitDelta(text: string): Promise<void> {
    if (!text) {
      return;
    }

    this.appendAnswer(text);
    await this.emit({
      type: "lane_message_delta",
      runId: this.runId,
      turnId: this.turnId,
      laneId: this.laneId,
      text,
    });
  }

  async emitSnapshot(text: string): Promise<void> {
    this.setAnswer(text);
    await this.emit({
      type: "lane_message_snapshot",
      runId: this.runId,
      turnId: this.turnId,
      laneId: this.laneId,
      text,
    });
  }

  async recordToolStarted(
    id: string,
    name: string,
    args: unknown,
  ): Promise<ToolCallTrace> {
    const call: ToolCallTrace = {
      id,
      name,
      status: "started",
      arguments: args,
      outputSummary: summarizeJson(args, 180),
      startedAt: nowIso(),
    };

    this.toolCalls.set(id, call);
    this.rawEvents.push(
      this.createTelemetryEvent("tool.started", call.startedAt, {
        toolCallId: id,
        toolName: name,
        arguments: args,
      }),
    );
    await this.emit({
      type: "tool_call_started",
      runId: this.runId,
      turnId: this.turnId,
      laneId: this.laneId,
      call,
    });

    return call;
  }

  async recordToolCompleted(id: string, output: unknown): Promise<ToolCallTrace> {
    const existing = this.toolCalls.get(id);
    const completedAt = nowIso();
    const call: ToolCallTrace = {
      ...(existing ?? {
        id,
        name: "tool",
        startedAt: completedAt,
        status: "started" as const,
      }),
      status: "completed",
      output,
      outputSummary: summarizeJson(output),
      completedAt,
      durationMs: existing ? elapsedMs(existing.startedAt, completedAt) : 0,
    };

    this.toolCalls.set(id, call);
    this.captureSources(output, call.name);
    this.rawEvents.push(
      this.createTelemetryEvent("tool.completed", completedAt, {
        toolCallId: id,
        toolName: call.name,
        durationMs: call.durationMs,
        outputSummary: call.outputSummary,
      }),
    );
    await this.emit({
      type: "tool_call_completed",
      runId: this.runId,
      turnId: this.turnId,
      laneId: this.laneId,
      call,
    });

    return call;
  }

  async recordToolFailed(id: string, error: string): Promise<ToolCallTrace> {
    const existing = this.toolCalls.get(id);
    const completedAt = nowIso();
    const call: ToolCallTrace = {
      ...(existing ?? {
        id,
        name: "tool",
        startedAt: completedAt,
        status: "started" as const,
      }),
      status: "failed",
      error,
      outputSummary: error,
      completedAt,
      durationMs: existing ? elapsedMs(existing.startedAt, completedAt) : 0,
    };

    this.toolCalls.set(id, call);
    this.rawEvents.push(
      this.createTelemetryEvent("tool.failed", completedAt, {
        toolCallId: id,
        toolName: call.name,
        durationMs: call.durationMs,
        error,
      }),
    );
    await this.emit({
      type: "tool_call_failed",
      runId: this.runId,
      turnId: this.turnId,
      laneId: this.laneId,
      call,
    });

    return call;
  }

  result(error?: string): LaneRunResult {
    const completedAt = nowIso();
    const durationMs = elapsedMs(this.startedAt, completedAt);
    const rawEvents = [
      ...this.rawEvents,
      this.createTelemetryEvent(
        error ? "lane.failed" : "lane.completed",
        completedAt,
        {
          completedAt,
          durationMs,
          toolCallCount: this.toolCalls.size,
          sourceCount: this.sources.size,
          tokenUsage: this.tokenUsage,
          eventCount: this.rawEvents.length + 1,
          error,
        },
      ),
    ];

    return {
      turnId: this.turnId,
      laneId: this.laneId,
      harnessName: LANE_LABELS[this.laneId],
      modelLabel: getLaneModelLabel(
        this.laneId,
        this.modelSize,
        this.modelProvider,
      ),
      reasoningEffort: this.reasoningEffort,
      effectiveReasoningEffort: titleCaseEffort(this.reasoningEffort),
      modelProvider: this.modelProvider,
      modelSize: this.modelSize,
      prompt: this.prompt,
      finalAnswer: this.finalAnswer.trim(),
      tokenUsage: this.tokenUsage,
      toolCalls: [...this.toolCalls.values()],
      sources: [...this.sources.values()],
      rawEvents,
      session: this.session,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      error,
    };
  }

  private createTelemetryEvent(
    phase: string,
    timestamp: string,
    details: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: "lane_telemetry",
      phase,
      laneId: this.laneId,
      runId: this.runId,
      turnId: this.turnId,
      timestamp,
      elapsedMs: elapsedMs(this.startedAt, timestamp),
      ...details,
    };
  }

  private captureSources(output: unknown, toolName: string): void {
    if (!output || typeof output !== "object") {
      return;
    }

    if (toolName === "retrieve_contents") {
      const value = output as RetrieveResultLike;
      for (const result of value.results ?? []) {
        if (!result.resourceUri && !result.id) {
          continue;
        }

        const key = result.resourceUri ?? `contents://${result.id}`;
        this.sources.set(key, {
          id: result.id,
          resourceUri: key,
          name: result.name,
          text: result.text,
          relevance: result.relevance ?? null,
          inspected: this.sources.get(key)?.inspected,
        });
      }
    }

    if (toolName === "inspect_content") {
      const value = output as InspectResultLike;
      const key = value.resourceUri ?? (value.id ? `contents://${value.id}` : "");

      if (key) {
        this.sources.set(key, {
          ...this.sources.get(key),
          id: value.id ?? this.sources.get(key)?.id,
          resourceUri: key,
          name: value.name ?? this.sources.get(key)?.name,
          text: value.text ?? this.sources.get(key)?.text,
          inspected: true,
        });
      }
    }

    if (toolName === "inspect_page") {
      const value = output as InspectPageResultLike;
      const key = value.url;

      if (key) {
        this.sources.set(key, {
          ...this.sources.get(key),
          resourceUri: key,
          name: this.sources.get(key)?.name ?? key,
          text: value.text ?? this.sources.get(key)?.text,
          inspected: true,
        });
      }
    }
  }
}
