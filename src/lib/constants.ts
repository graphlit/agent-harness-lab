import type {
  LaneId,
  ModelProviderPreference,
  ModelSize,
  ReasoningEffort,
} from "@/lib/types";

export const AGENT_HARNESS_LAB_BOOTSTRAP_VERSION = "2026-06-12d";

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_MODEL_PROVIDER: ModelProviderPreference = "openai";
export const DEFAULT_MODEL_SIZE: ModelSize = "large";
export const MODEL_PROVIDER_PREFERENCES: ModelProviderPreference[] = [
  "openai",
  "anthropic",
  "google",
];

export const DEFAULT_LANES: LaneId[] = [
  "graphlit",
  "openai",
  "vercel",
  "langgraph",
  "mastra",
  "claude",
  "google",
];

export const SYSTEM_PROMPT = [
  "Answer from Graphlit content when the user asks about private knowledge.",
  "Use retrieve_contents to find relevant content.",
  "Use inspect_content before making answer-critical source-backed claims.",
  "If retrieved evidence is weak or missing, say so plainly.",
  "Do not invent citations or content names.",
].join(" ");

export const JUDGE_RUBRIC_VERSION = "2026-06-11a";

export const MODEL_PROVIDER_LABELS: Record<ModelProviderPreference, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

export const GRAPHLIT_SPEC_NAMES: Record<
  ModelProviderPreference,
  Record<ModelSize, Record<ReasoningEffort, string>>
> = {
  openai: {
    large: {
      low: "Graphlit Agent Harness Lab - Graphlit - OpenAI - Large - Low",
      medium: "Graphlit Agent Harness Lab - Graphlit - OpenAI - Large - Medium",
      high: "Graphlit Agent Harness Lab - Graphlit - OpenAI - Large - High",
    },
    small: {
      low: "Graphlit Agent Harness Lab - Graphlit - OpenAI - Small - Low",
      medium: "Graphlit Agent Harness Lab - Graphlit - OpenAI - Small - Medium",
      high: "Graphlit Agent Harness Lab - Graphlit - OpenAI - Small - High",
    },
  },
  anthropic: {
    large: {
      low: "Graphlit Agent Harness Lab - Graphlit - Anthropic - Large - Low",
      medium:
        "Graphlit Agent Harness Lab - Graphlit - Anthropic - Large - Medium",
      high: "Graphlit Agent Harness Lab - Graphlit - Anthropic - Large - High",
    },
    small: {
      low: "Graphlit Agent Harness Lab - Graphlit - Anthropic - Small - Low",
      medium:
        "Graphlit Agent Harness Lab - Graphlit - Anthropic - Small - Medium",
      high: "Graphlit Agent Harness Lab - Graphlit - Anthropic - Small - High",
    },
  },
  google: {
    large: {
      low: "Graphlit Agent Harness Lab - Graphlit - Google - Large - Low",
      medium: "Graphlit Agent Harness Lab - Graphlit - Google - Large - Medium",
      high: "Graphlit Agent Harness Lab - Graphlit - Google - Large - High",
    },
    small: {
      low: "Graphlit Agent Harness Lab - Graphlit - Google - Small - Low",
      medium: "Graphlit Agent Harness Lab - Graphlit - Google - Small - Medium",
      high: "Graphlit Agent Harness Lab - Graphlit - Google - Small - High",
    },
  },
};

export const JUDGE_SPEC_NAME = "Graphlit Agent Harness Lab - Judge";

export const LANE_LABELS: Record<LaneId, string> = {
  graphlit: "Graphlit",
  openai: "OpenAI Agents SDK",
  vercel: "Vercel AI SDK",
  langgraph: "LangGraph",
  mastra: "Mastra",
  claude: "Claude Agent SDK",
  google: "Google ADK",
};

export const PROVIDER_MODEL_LABELS: Record<
  ModelProviderPreference,
  Record<ModelSize, string>
> = {
  openai: {
    large: "GPT-5.5",
    small: "GPT-5 Mini",
  },
  anthropic: {
    large: "Claude Opus 4.8",
    small: "Claude Sonnet 4.6",
  },
  google: {
    large: "Gemini Pro",
    small: "Gemini Flash",
  },
};

export const MODEL_NEUTRAL_LANES = new Set<LaneId>([
  "graphlit",
  "vercel",
  "langgraph",
  "mastra",
]);

export const LANE_MODEL_LABELS: Record<LaneId, Record<ModelSize, string>> = {
  graphlit: {
    large: PROVIDER_MODEL_LABELS.openai.large,
    small: PROVIDER_MODEL_LABELS.openai.small,
  },
  openai: {
    large: PROVIDER_MODEL_LABELS.openai.large,
    small: PROVIDER_MODEL_LABELS.openai.small,
  },
  vercel: {
    large: PROVIDER_MODEL_LABELS.openai.large,
    small: PROVIDER_MODEL_LABELS.openai.small,
  },
  langgraph: {
    large: PROVIDER_MODEL_LABELS.openai.large,
    small: PROVIDER_MODEL_LABELS.openai.small,
  },
  mastra: {
    large: PROVIDER_MODEL_LABELS.openai.large,
    small: PROVIDER_MODEL_LABELS.openai.small,
  },
  claude: {
    large: PROVIDER_MODEL_LABELS.anthropic.large,
    small: PROVIDER_MODEL_LABELS.anthropic.small,
  },
  google: {
    large: PROVIDER_MODEL_LABELS.google.large,
    small: PROVIDER_MODEL_LABELS.google.small,
  },
};

export const OPENAI_MODELS: Record<ModelSize, string> = {
  large: "gpt-5.5",
  small: "gpt-5-mini",
};

export const CLAUDE_MODELS: Record<ModelSize, string> = {
  large: "claude-opus-4-8",
  small: "claude-sonnet-4-6",
};

export const GOOGLE_MODELS: Record<ModelSize, string> = {
  large: "gemini-pro-latest",
  small: "gemini-flash-latest",
};

export const MODEL_PROVIDER_MODEL_IDS: Record<
  ModelProviderPreference,
  Record<ModelSize, string>
> = {
  openai: OPENAI_MODELS,
  anthropic: CLAUDE_MODELS,
  google: GOOGLE_MODELS,
};

export function titleCaseEffort(effort: ReasoningEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function getLaneModelLabel(
  laneId: LaneId,
  modelSize: ModelSize,
  modelProvider: ModelProviderPreference = DEFAULT_MODEL_PROVIDER,
): string {
  if (MODEL_NEUTRAL_LANES.has(laneId)) {
    return PROVIDER_MODEL_LABELS[modelProvider][modelSize];
  }

  return LANE_MODEL_LABELS[laneId][modelSize];
}
