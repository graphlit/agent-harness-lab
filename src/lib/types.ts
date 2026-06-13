export const LANE_IDS = [
  "graphlit",
  "openai",
  "vercel",
  "langgraph",
  "mastra",
  "claude",
  "google",
] as const;

export type LaneId = (typeof LANE_IDS)[number];
export type ReasoningEffort = "low" | "medium" | "high";
export type ModelSize = "large" | "small";
export type ModelProviderPreference = "openai" | "anthropic" | "google";
export type LaneStatus =
  | "idle"
  | "queued"
  | "running"
  | "tool_calling"
  | "completed"
  | "failed";

export type JsonRecord = Record<string, unknown>;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface LaneSessionState {
  graphlitConversationId?: string;
  openAiSessionId?: string;
  openAiItems?: JsonValue[];
  vercelMessages?: JsonValue[];
  langGraphThreadId?: string;
  langGraphMessages?: JsonValue[];
  mastraResourceId?: string;
  mastraThreadId?: string;
  claudeSessionId?: string;
  googleSessionId?: string;
}

export interface ToolCallTrace {
  id: string;
  name: string;
  status: "started" | "completed" | "failed";
  arguments?: unknown;
  output?: unknown;
  outputSummary?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface SourceTrace {
  resourceUri: string;
  id?: string;
  name?: string;
  text?: string;
  relevance?: number | null;
  inspected?: boolean;
}

export interface TokenUsageTrace {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  source: string;
}

export interface LaneRunResult {
  turnId: string;
  laneId: LaneId;
  harnessName: string;
  modelLabel?: string;
  reasoningEffort?: ReasoningEffort;
  effectiveReasoningEffort?: string;
  modelProvider?: ModelProviderPreference;
  modelSize?: ModelSize;
  prompt: string;
  finalAnswer: string;
  tokenUsage?: TokenUsageTrace;
  toolCalls: ToolCallTrace[];
  sources: SourceTrace[];
  rawEvents: unknown[];
  session?: LaneSessionState;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface JudgeLaneScore {
  anonymousId: string;
  laneId?: LaneId;
  overallScore: number;
  retrievalUse: number;
  sourceInspection: number;
  groundedness: number;
  answerHelpfulness: number;
  unsupportedClaimRisk: number;
  traceEvidence: string[];
  strengths: string[];
  weaknesses: string[];
}

export interface JudgeResult {
  winnerAnonymousId: string | null;
  winnerLaneId?: LaneId | null;
  winnerReason: string;
  summary: string;
  lanes: JudgeLaneScore[];
  pairwiseNotes: Array<{
    betterAnonymousId: string | null;
    betterLaneId?: LaneId | null;
    worseAnonymousId: string | null;
    worseLaneId?: LaneId | null;
    reason: string;
  }>;
  biasChecks: {
    laneOrderRandomized: boolean;
    verbosityConsidered: boolean;
    unsupportedClaimsConsidered: boolean;
    externalKnowledgeAvoided: boolean;
  };
}

export interface RunRequest {
  sessionId: string;
  turnId: string;
  prompt: string;
  lanes: LaneId[];
  judge: boolean;
  reasoningEffort?: ReasoningEffort;
  modelProvider?: ModelProviderPreference;
  modelSize?: ModelSize;
  systemPromptEnabled?: boolean;
  runtimeUtc?: string;
  laneSessions?: Partial<Record<LaneId, LaneSessionState>>;
}

export interface BootstrapSpecificationRef {
  id: string;
  name: string;
}

export type GraphlitEffortSpecifications = Record<
  ReasoningEffort,
  BootstrapSpecificationRef
>;
export type GraphlitModelSpecifications = Record<
  ModelSize,
  GraphlitEffortSpecifications
>;
export type GraphlitProviderSpecifications = Record<
  ModelProviderPreference,
  GraphlitModelSpecifications
>;

export interface StoredBootstrapState {
  bootstrapVersion: string | null;
  specifications: {
    graphlit?: Partial<GraphlitProviderSpecifications>;
    judge?: BootstrapSpecificationRef;
  };
  updatedAt?: string;
}

export interface BootstrapStatus {
  targetBootstrapVersion: string;
  storedBootstrapVersion: string | null;
  defaultReasoningEffort: ReasoningEffort;
  defaultModelProvider: ModelProviderPreference;
  defaultModelSize: ModelSize;
  bootstrapUpToDate: boolean;
  rebootstrapPerformed: boolean;
  warning?: string;
  graphlit: { ready: boolean; error?: string };
  modelProviders: Record<
    ModelProviderPreference,
    { enabled: boolean; reason?: string }
  >;
  specifications: {
    graphlit?: Partial<GraphlitProviderSpecifications>;
    judge?: BootstrapSpecificationRef;
  };
  lanes: Record<LaneId, { enabled: boolean; reason?: string }>;
  judge: { enabled: boolean; reason?: string };
}

export type LabRunEvent =
  | { type: "run_started"; runId: string; turnId: string; prompt: string }
  | { type: "lane_started"; runId: string; turnId: string; laneId: LaneId }
  | {
      type: "lane_trace";
      runId: string;
      turnId: string;
      laneId: LaneId;
      event: unknown;
    }
  | {
      type: "lane_message_delta";
      runId: string;
      turnId: string;
      laneId: LaneId;
      text: string;
    }
  | {
      type: "lane_message_snapshot";
      runId: string;
      turnId: string;
      laneId: LaneId;
      text: string;
    }
  | {
      type: "lane_reasoning_delta";
      runId: string;
      turnId: string;
      laneId: LaneId;
      text: string;
    }
  | {
      type: "tool_call_started";
      runId: string;
      turnId: string;
      laneId: LaneId;
      call: ToolCallTrace;
    }
  | {
      type: "tool_call_completed";
      runId: string;
      turnId: string;
      laneId: LaneId;
      call: ToolCallTrace;
    }
  | {
      type: "tool_call_failed";
      runId: string;
      turnId: string;
      laneId: LaneId;
      call: ToolCallTrace;
    }
  | {
      type: "lane_completed";
      runId: string;
      turnId: string;
      laneId: LaneId;
      result: LaneRunResult;
    }
  | {
      type: "lane_failed";
      runId: string;
      turnId: string;
      laneId: LaneId;
      error: string;
    }
  | { type: "judge_started"; runId: string; turnId: string }
  | {
      type: "judge_completed";
      runId: string;
      turnId: string;
      result: JudgeResult;
    }
  | { type: "judge_failed"; runId: string; turnId: string; error: string }
  | { type: "run_completed"; runId: string; turnId: string };

export type RunEventEmitter = (event: LabRunEvent) => void | Promise<void>;

export interface LaneRunContext {
  runId: string;
  turnId: string;
  sessionId: string;
  prompt: string;
  reasoningEffort: ReasoningEffort;
  modelProvider: ModelProviderPreference;
  modelSize: ModelSize;
  systemPrompt?: string;
  runtimeInstructions?: string;
  runtimeUtc?: string;
  emit: RunEventEmitter;
  abortSignal?: AbortSignal;
  laneSession?: LaneSessionState;
  graphlitSpecification?: BootstrapSpecificationRef;
}
