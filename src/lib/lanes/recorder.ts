import {
  LANE_LABELS,
  LANE_MODEL_LABELS,
  titleCaseEffort,
} from "@/lib/constants";
import type {
  LaneId,
  LaneRunResult,
  LaneSessionState,
  ModelSize,
  ReasoningEffort,
  RunEventEmitter,
  SourceTrace,
  ToolCallTrace,
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

export class LaneRunRecorder {
  readonly laneId: LaneId;
  readonly runId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly modelSize: ModelSize;
  readonly startedAt = nowIso();

  private readonly emit: RunEventEmitter;
  private readonly toolCalls = new Map<string, ToolCallTrace>();
  private readonly sources = new Map<string, SourceTrace>();
  private readonly rawEvents: unknown[] = [];
  private session: LaneSessionState = {};
  private finalAnswer = "";

  constructor(options: {
    laneId: LaneId;
    runId: string;
    turnId: string;
    prompt: string;
    reasoningEffort: ReasoningEffort;
    modelSize: ModelSize;
    emit: RunEventEmitter;
  }) {
    this.laneId = options.laneId;
    this.runId = options.runId;
    this.turnId = options.turnId;
    this.prompt = options.prompt;
    this.reasoningEffort = options.reasoningEffort;
    this.modelSize = options.modelSize;
    this.emit = options.emit;
  }

  recordRaw(event: unknown): void {
    this.rawEvents.push(event);
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

    return {
      turnId: this.turnId,
      laneId: this.laneId,
      harnessName: LANE_LABELS[this.laneId],
      modelLabel: LANE_MODEL_LABELS[this.laneId][this.modelSize],
      reasoningEffort: this.reasoningEffort,
      effectiveReasoningEffort: titleCaseEffort(this.reasoningEffort),
      modelSize: this.modelSize,
      prompt: this.prompt,
      finalAnswer: this.finalAnswer.trim(),
      toolCalls: [...this.toolCalls.values()],
      sources: [...this.sources.values()],
      rawEvents: this.rawEvents,
      session: this.session,
      startedAt: this.startedAt,
      completedAt,
      durationMs: elapsedMs(this.startedAt, completedAt),
      error,
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
  }
}
