import "server-only";

import { Types } from "graphlit-client";

import { JUDGE_RUBRIC_VERSION, LANE_LABELS } from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import {
  JudgeResultSchema,
  type ParsedJudgeResult,
  scoreAgentHarnessRunJsonSchema,
} from "@/lib/judge/schema";
import type {
  BootstrapSpecificationRef,
  JudgeResult,
  LaneId,
  LaneRunResult,
  ToolCallTrace,
} from "@/lib/types";
import { summarizeJson } from "@/lib/utils";

const ANONYMOUS_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const MAX_JUDGE_FINAL_ANSWER_CHARS = 100_000;
const MAX_JUDGE_TOOL_OUTPUT_CHARS = 12_000;
const MAX_JUDGE_SOURCE_TEXT_CHARS = 12_000;
const MAX_JUDGE_RESULT_TEXT_CHARS = 2_000;

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const values = [...items];
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  for (let index = values.length - 1; index > 0; index -= 1) {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    const swapIndex = hash % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  return values;
}

function anonymousIdForIndex(index: number): string {
  const anonymousId = ANONYMOUS_IDS[index];

  if (!anonymousId) {
    throw new Error(`Judge supports at most ${ANONYMOUS_IDS.length} lanes.`);
  }

  return anonymousId;
}

function buildJudgePrompt(): string {
  return [
    "You are judging agent harness outputs for a developer-facing RAG lab.",
    "Use only the prompt, final answers, tool calls, and source traces in the input.",
    "Use a two-pass evaluation process.",
    "Pass 1: score each lane independently against only that lane's own final answer, tool responses, source traces, and the user prompt. Do not use other lanes as a standard when assigning retrievalUse, sourceInspection, groundedness, or unsupportedClaimRisk.",
    "Pass 2: after every lane has an independent score, compare lanes to choose the winner, write pairwise notes, and resolve close overall rankings.",
    "Cross-lane comparison may distinguish completeness, concision, and usefulness, but must not retroactively lower an individually supported lane because another lane retrieved richer snippets, more sources, or extra details.",
    "Derive the answer contract from the user's prompt before scoring. For broad latest/current questions, prioritize the core facts a user would reasonably expect for that domain, such as current status, most recent material change, next expected step, and any clearly central developments.",
    "Do not invent a hidden required checklist from details found by only some lanes. Incidental entity details, side updates, historical comparisons, metrics, quotes, examples, and background context can improve helpfulness only when they are relevant and supported, but they must not define the scoring tiers unless the user asked for that level of detail or the detail is clearly central to the answer.",
    "A lane that answers the core question accurately and with support should remain highly grounded even if it omits optional extra details that another lane included.",
    "When comparing lanes, treat optional supported details as tie-breakers, not as the main basis for severe penalties.",
    "Evaluate groundedness claim by claim. A claim is supported when it appears in the lane's own evidence or is a direct, low-risk inference from that evidence.",
    "Do not use your training data, model memory, or outside facts to validate factual claims, especially for current, recent, latest, or time-sensitive topics.",
    "If an answer contains information that conflicts with your prior knowledge but is supported by the lane's retrieved or inspected sources, treat the run evidence as authoritative for judging.",
    "Only call a factual claim a hallucination when it is contradicted by the provided traces/sources or when the lane presents it without support from its own answer, tools, or sources.",
    "Use tool responses and source traces primarily to judge answer fidelity: whether the final answer accurately reflects the evidence the lane actually received.",
    "Do not penalize retrievalUse, sourceInspection, groundedness, or overallScore merely because one search provider returned shorter snippets, fewer result fields, or less verbose tool output than another provider.",
    "Search result verbosity is a provider artifact, not an agent quality signal. A lane with shorter snippets can score as highly as a lane with longer snippets when its final answer stays within the facts present in those snippets.",
    "Do not write that a lane failed to retrieve detailed snippets, lacked rich snippets, used empty video links, or had basic search results as a weakness unless the lane chose irrelevant queries, ignored available relevant evidence, or the final answer depended on facts not visible in its evidence.",
    "When evidence is thin, phrase the weakness as answer-fidelity risk: identify which final-answer claims are not visible in the provided tool responses or source traces.",
    "Do not reward a lane for receiving verbose search snippets if another lane retrieved equivalent answer-critical facts in shorter form.",
    "Score retrievalUse based on relevant tool selection, query intent, and whether the lane used the evidence it received; do not score it by raw snippet length or result verbosity.",
    "Score sourceInspection based on whether the lane inspected or used available source-level evidence when the answer required it; a short search snippet is not itself a source-inspection failure.",
    "If a lane only has brief search snippets, treat those snippets as enough support only for claims they actually contain. Penalize unsupported extra claims, not the provider's snippet brevity.",
    "Do not reward verbosity by default.",
    "Penalize unsupported claims and missing source inspection.",
    "Prefer answers that visibly use retrieved Graphlit evidence.",
    "Score retrievalUse, sourceInspection, groundedness, and answerHelpfulness as positive 0-10 dimensions where higher is better.",
    "Score unsupportedClaimRisk as a 0-10 risk dimension where lower is better.",
    "Set overallScore as the holistic turn score derived from the same dimensions, using answerHelpfulness as the primary tie-breaker when retrieval and groundedness are similar.",
    "If two lanes have identical dimension scores, give them the same overallScore unless strengths, weaknesses, or pairwise notes clearly explain a meaningful difference.",
    "Lanes are anonymized for scoring. Do not infer harness identity or reward a lane because of its name.",
    "Use anonymousId values for structured ID fields only.",
    "The input includes expectedLaneCount and requiredAnonymousIds. The lanes array you return MUST contain exactly one score object for every requiredAnonymousId. Never say only one lane was provided when expectedLaneCount is greater than 1.",
    "Use the provided friendlyName values in all human-readable prose fields. Never write 'Lane A', 'Lane B', or similar anonymous labels in summary, winnerReason, strengths, weaknesses, traceEvidence, or pairwise notes.",
    "Example: write 'Graphlit is the best response...' instead of 'Lane C is the best response...'.",
    "Set biasChecks.individualScoringBeforePairwise to true only if you independently scored each lane before making winner or pairwise comparisons.",
    "Set biasChecks.providerSnippetNeutrality to true only if you avoided rewarding or penalizing lanes based on raw search snippet length or provider result verbosity.",
    "Set biasChecks.optionalDetailNotOverweighted to true only if you did not turn optional supported details into hidden mandatory scoring criteria.",
    "Call score_agent_harness_run exactly once with the structured scores.",
  ].join(" ");
}

function logJudgeRunner(phase: string, details?: Record<string, unknown>): void {
  console.info(`[agent-harness-lab/judge] ${phase}`, details ?? {});
}

function clipText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function compactSearchLikeOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }

  const value = output as {
    query?: unknown;
    searchService?: unknown;
    results?: unknown;
  };

  if (!Array.isArray(value.results)) {
    return undefined;
  }

  return {
    query: typeof value.query === "string" ? value.query : undefined,
    searchService:
      typeof value.searchService === "string" ? value.searchService : undefined,
    results: value.results.slice(0, 10).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }

      const result = item as Record<string, unknown>;

      return {
        title: result.title,
        uri: result.uri,
        text: clipText(result.text, MAX_JUDGE_RESULT_TEXT_CHARS),
        score: result.score ?? null,
      };
    }),
  };
}

function compactToolOutput(call: ToolCallTrace): unknown {
  if (call.output === undefined) {
    return call.outputSummary;
  }

  const searchLike = compactSearchLikeOutput(call.output);

  if (searchLike) {
    return searchLike;
  }

  return summarizeJson(call.output, MAX_JUDGE_TOOL_OUTPUT_CHARS);
}

function compactLaneResult(result: LaneRunResult, anonymousId: string) {
  const friendlyName = LANE_LABELS[result.laneId];

  return {
    anonymousId,
    friendlyName,
    finalAnswer: clipText(result.finalAnswer, MAX_JUDGE_FINAL_ANSWER_CHARS),
    toolCalls: result.toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments,
      output: compactToolOutput(call),
      durationMs: call.durationMs,
      error: call.error,
    })),
    sources: result.sources.map((source) => ({
      resourceUri: source.resourceUri,
      name: source.name,
      text: clipText(source.text, MAX_JUDGE_SOURCE_TEXT_CHARS),
      relevance: source.relevance ?? null,
      inspected: source.inspected ?? false,
    })),
    durationMs: result.durationMs,
  };
}

function validateJudgeCoverage(
  parsed: ParsedJudgeResult,
  ordered: LaneRunResult[],
  anonymousToLane: Map<string, LaneId>,
): void {
  const expected = new Set(
    ordered.map((_result, index) => anonymousIdForIndex(index)),
  );
  const actual = new Set(parsed.lanes.map((lane) => lane.anonymousId));
  const missing = [...expected].filter((anonymousId) => !actual.has(anonymousId));
  const extra = [...actual].filter((anonymousId) => !expected.has(anonymousId));

  if (missing.length > 0 || extra.length > 0 || actual.size !== expected.size) {
    const missingNames = missing
      .map((anonymousId) => anonymousToLane.get(anonymousId))
      .filter((laneId): laneId is LaneId => Boolean(laneId))
      .map((laneId) => LANE_LABELS[laneId]);

    throw new Error(
      [
        "Judge returned incomplete lane coverage.",
        missingNames.length
          ? `Missing completed lanes: ${missingNames.join(", ")}.`
          : undefined,
        extra.length ? `Unexpected anonymous IDs: ${extra.join(", ")}.` : undefined,
        `Expected ${expected.size} scored lanes, received ${parsed.lanes.length}.`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

function formatFriendlyList(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function replaceAnonymousLaneLabels(
  text: string,
  anonymousToLane: Map<string, LaneId>,
): string {
  const labelFor = (anonymousId: string): string | null => {
    const laneId = anonymousToLane.get(anonymousId.toUpperCase());
    return laneId ? LANE_LABELS[laneId] : null;
  };

  return text
    .replace(
      /\bLanes\s+([A-H](?:(?:,\s*and\s+|,\s*|\s+and\s+)[A-H])*)/gi,
      (match, anonymousIds: string) => {
        const names = Array.from(anonymousIds.matchAll(/[A-H]/gi))
          .map(([anonymousId]) => labelFor(anonymousId))
          .filter((name): name is string => Boolean(name));

        return names.length > 0 ? formatFriendlyList(names) : match;
      },
    )
    .replace(/\bLane\s+([A-H])\b/gi, (match, anonymousId: string) => {
      return labelFor(anonymousId) ?? match;
    });
}

function replaceAnonymousLaneLabelsInList(
  values: string[],
  anonymousToLane: Map<string, LaneId>,
): string[] {
  return values.map((value) =>
    replaceAnonymousLaneLabels(value, anonymousToLane),
  );
}

export async function runJudge(options: {
  runId: string;
  prompt: string;
  results: LaneRunResult[];
  failed: Array<{ laneId: LaneId; error: string }>;
  specification: BootstrapSpecificationRef;
}): Promise<JudgeResult> {
  const ordered = deterministicShuffle(options.results, options.runId);
  const anonymousToLane = new Map<string, LaneId>();
  const laneToAnonymous = new Map<LaneId, string>();

  ordered.forEach((result, index) => {
    const anonymousId = anonymousIdForIndex(index);
    anonymousToLane.set(anonymousId, result.laneId);
    laneToAnonymous.set(result.laneId, anonymousId);
  });

  const judgeInput = {
    prompt: options.prompt,
    rubricVersion: JUDGE_RUBRIC_VERSION,
    expectedLaneCount: ordered.length,
    requiredAnonymousIds: ordered.map((_result, index) =>
      anonymousIdForIndex(index),
    ),
    laneNameMap: ordered.map((result, index) => ({
      anonymousId: anonymousIdForIndex(index),
      friendlyName: LANE_LABELS[result.laneId],
    })),
    lanes: ordered.map((result, index) =>
      compactLaneResult(result, anonymousIdForIndex(index)),
    ),
    failedLanes: options.failed.map((failure) => ({
      anonymousId: laneToAnonymous.get(failure.laneId) ?? null,
      friendlyName: LANE_LABELS[failure.laneId],
      error: failure.error,
    })),
  };
  const judgeInputJson = JSON.stringify(judgeInput);

  logJudgeRunner("input.prepared", {
    runId: options.runId,
    expectedLaneCount: ordered.length,
    inputChars: judgeInputJson.length,
    lanes: ordered.map((result, index) => ({
      anonymousId: anonymousIdForIndex(index),
      laneId: result.laneId,
      friendlyName: LANE_LABELS[result.laneId],
      answerChars: result.finalAnswer.length,
      toolCalls: result.toolCalls.length,
      sources: result.sources.length,
    })),
  });

  const client = createGraphlitClient();
  const response = await client.extractText(
    buildJudgePrompt(),
    judgeInputJson,
    [
      {
        name: "score_agent_harness_run",
        description:
          "Score anonymized agent harness responses with retrieval, groundedness, and helpfulness criteria.",
        schema: JSON.stringify(scoreAgentHarnessRunJsonSchema),
      },
    ],
    { id: options.specification.id },
    Types.TextTypes.Plain,
  );
  const value = response.extractText?.find(
    (item) => item?.name === "score_agent_harness_run",
  )?.value;

  if (!value) {
    throw new Error("Judge did not return a score_agent_harness_run value.");
  }

  const parsed = JudgeResultSchema.parse(JSON.parse(value));

  validateJudgeCoverage(parsed, ordered, anonymousToLane);

  logJudgeRunner("result.parsed", {
    runId: options.runId,
    scoredLaneCount: parsed.lanes.length,
    scoredAnonymousIds: parsed.lanes.map((lane) => lane.anonymousId),
    winnerAnonymousId: parsed.winnerAnonymousId,
  });

  return {
    ...parsed,
    winnerReason: replaceAnonymousLaneLabels(
      parsed.winnerReason,
      anonymousToLane,
    ),
    summary: replaceAnonymousLaneLabels(parsed.summary, anonymousToLane),
    winnerLaneId: parsed.winnerAnonymousId
      ? (anonymousToLane.get(parsed.winnerAnonymousId) ?? null)
      : null,
    lanes: parsed.lanes.map((lane) => ({
      ...lane,
      laneId: anonymousToLane.get(lane.anonymousId),
      traceEvidence: replaceAnonymousLaneLabelsInList(
        lane.traceEvidence,
        anonymousToLane,
      ),
      strengths: replaceAnonymousLaneLabelsInList(
        lane.strengths,
        anonymousToLane,
      ),
      weaknesses: replaceAnonymousLaneLabelsInList(
        lane.weaknesses,
        anonymousToLane,
      ),
    })),
    pairwiseNotes: parsed.pairwiseNotes.map((note) => ({
      ...note,
      betterLaneId: note.betterAnonymousId
        ? (anonymousToLane.get(note.betterAnonymousId) ?? null)
        : null,
      worseLaneId: note.worseAnonymousId
        ? (anonymousToLane.get(note.worseAnonymousId) ?? null)
        : null,
      reason: replaceAnonymousLaneLabels(note.reason, anonymousToLane),
    })),
  };
}
