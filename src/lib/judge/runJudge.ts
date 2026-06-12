import "server-only";

import { Types } from "graphlit-client";

import { JUDGE_RUBRIC_VERSION } from "@/lib/constants";
import { createGraphlitClient } from "@/lib/graphlit/client";
import {
  JudgeResultSchema,
  scoreAgentHarnessRunJsonSchema,
} from "@/lib/judge/schema";
import type {
  BootstrapSpecificationRef,
  JudgeResult,
  LaneId,
  LaneRunResult,
} from "@/lib/types";
import { summarizeJson } from "@/lib/utils";

const ANONYMOUS_IDS = ["A", "B", "C", "D"] as const;

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

function buildJudgePrompt(): string {
  return [
    "You are judging agent harness outputs for a developer-facing RAG lab.",
    "Use only the prompt, final answers, tool calls, and source traces in the input.",
    "Do not reward verbosity by default.",
    "Penalize unsupported claims and missing source inspection.",
    "Prefer answers that visibly use retrieved Graphlit evidence.",
    "Lanes are anonymized. Do not infer harness identity.",
    "Call score_agent_harness_run exactly once with the structured scores.",
  ].join(" ");
}

function compactLaneResult(result: LaneRunResult, anonymousId: string) {
  return {
    anonymousId,
    finalAnswer: result.finalAnswer,
    toolCalls: result.toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments,
      outputSummary: call.outputSummary ?? summarizeJson(call.output, 240),
      durationMs: call.durationMs,
      error: call.error,
    })),
    sources: result.sources.map((source) => ({
      resourceUri: source.resourceUri,
      name: source.name,
      snippet: source.text?.slice(0, 800),
      relevance: source.relevance ?? null,
    })),
    durationMs: result.durationMs,
  };
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
    const anonymousId = ANONYMOUS_IDS[index];
    anonymousToLane.set(anonymousId, result.laneId);
    laneToAnonymous.set(result.laneId, anonymousId);
  });

  const judgeInput = {
    prompt: options.prompt,
    rubricVersion: JUDGE_RUBRIC_VERSION,
    lanes: ordered.map((result, index) =>
      compactLaneResult(result, ANONYMOUS_IDS[index]),
    ),
    failedLanes: options.failed.map((failure) => ({
      anonymousId: laneToAnonymous.get(failure.laneId) ?? null,
      error: failure.error,
    })),
  };
  const client = createGraphlitClient();
  const response = await client.extractText(
    buildJudgePrompt(),
    JSON.stringify(judgeInput),
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

  return {
    ...parsed,
    winnerLaneId: parsed.winnerAnonymousId
      ? (anonymousToLane.get(parsed.winnerAnonymousId) ?? null)
      : null,
    lanes: parsed.lanes.map((lane) => ({
      ...lane,
      laneId: anonymousToLane.get(lane.anonymousId),
    })),
    pairwiseNotes: parsed.pairwiseNotes.map((note) => ({
      ...note,
      betterLaneId: note.betterAnonymousId
        ? (anonymousToLane.get(note.betterAnonymousId) ?? null)
        : null,
      worseLaneId: note.worseAnonymousId
        ? (anonymousToLane.get(note.worseAnonymousId) ?? null)
        : null,
    })),
  };
}
