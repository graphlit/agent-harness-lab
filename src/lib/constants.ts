import type { LaneId, ModelSize, ReasoningEffort } from "@/lib/types";

export const AGENT_HARNESS_LAB_BOOTSTRAP_VERSION = "2026-06-12a";

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_MODEL_SIZE: ModelSize = "large";

export const DEFAULT_LANES: LaneId[] = [
  "graphlit",
  "openai",
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

export const GRAPHLIT_SPEC_NAMES: Record<
  ModelSize,
  Record<ReasoningEffort, string>
> = {
  large: {
    low: "Graphlit Agent Harness Lab - Graphlit - Large - Low",
    medium: "Graphlit Agent Harness Lab - Graphlit - Large - Medium",
    high: "Graphlit Agent Harness Lab - Graphlit - Large - High",
  },
  small: {
    low: "Graphlit Agent Harness Lab - Graphlit - Small - Low",
    medium: "Graphlit Agent Harness Lab - Graphlit - Small - Medium",
    high: "Graphlit Agent Harness Lab - Graphlit - Small - High",
  },
};

export const JUDGE_SPEC_NAME = "Graphlit Agent Harness Lab - Judge";

export const LANE_LABELS: Record<LaneId, string> = {
  graphlit: "Graphlit",
  openai: "OpenAI Agents SDK",
  mastra: "Mastra",
  claude: "Claude Agent SDK",
  google: "Google ADK",
};

export const LANE_MODEL_LABELS: Record<LaneId, Record<ModelSize, string>> = {
  graphlit: {
    large: "GPT-5.5",
    small: "GPT-5 Mini",
  },
  openai: {
    large: "GPT-5.5",
    small: "GPT-5 Mini",
  },
  mastra: {
    large: "GPT-5.5",
    small: "GPT-5 Mini",
  },
  claude: {
    large: "Claude Opus 4.8",
    small: "Claude Sonnet 4",
  },
  google: {
    large: "Gemini Pro",
    small: "Gemini Flash",
  },
};

export const OPENAI_MODELS: Record<ModelSize, string> = {
  large: "gpt-5.5",
  small: "gpt-5-mini",
};

export const MASTRA_MODEL_IDS: Record<ModelSize, string> = {
  large: "openai/gpt-5.5",
  small: "openai/gpt-5-mini",
};

export const CLAUDE_MODELS: Record<ModelSize, string> = {
  large: "claude-opus-4-8",
  small: "claude-sonnet-4",
};

export const GOOGLE_MODELS: Record<ModelSize, string> = {
  large: "gemini-pro-latest",
  small: "gemini-flash-latest",
};

export function titleCaseEffort(effort: ReasoningEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
