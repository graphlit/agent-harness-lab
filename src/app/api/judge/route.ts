import { NextRequest } from "next/server";
import { z } from "zod";

import type { LaneId, LaneRunResult } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JudgeRequestSchema = z.object({
  runId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  results: z.array(z.unknown()).default([]),
  failed: z
    .array(
      z.object({
        laneId: z.string(),
        error: z.string(),
      }),
    )
    .default([]),
});

function logJudge(phase: string, details?: Record<string, unknown>): void {
  console.info(`[agent-harness-lab/api/judge] ${phase}`, details ?? {});
}

function summarizeJudgeInput(results: LaneRunResult[]) {
  return results.map((result) => ({
    laneId: result.laneId,
    answerChars: result.finalAnswer.length,
    toolCalls: result.toolCalls.length,
    sources: result.sources.length,
    rawEvents: result.rawEvents.length,
    durationMs: result.durationMs,
    tokenUsage: result.tokenUsage?.totalTokens,
  }));
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = JudgeRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const runId = parsed.data.runId;
  const turnId = parsed.data.turnId;
  const prompt = parsed.data.prompt;
  const results = parsed.data.results as LaneRunResult[];
  const failed = parsed.data.failed as Array<{ laneId: LaneId; error: string }>;

  try {
    logJudge("request.received", {
      runId,
      turnId,
      bodyChars: JSON.stringify(body).length,
      completed: results.map((result) => result.laneId),
      completedCount: results.length,
      lanes: summarizeJudgeInput(results),
      failed,
      failedCount: failed.length,
    });

    logJudge("bootstrap.import.start", { runId, turnId });
    const { bootstrapAgentHarnessLab } = await import(
      "@/lib/graphlit/bootstrap"
    );
    logJudge("bootstrap.import.success", { runId, turnId });
    const bootstrap = await bootstrapAgentHarnessLab();

    if (!bootstrap.judge.enabled || !bootstrap.specifications.judge?.id) {
      return Response.json(
        {
          error:
            bootstrap.judge.reason ?? "Judge specification is not available.",
        },
        { status: 400 },
      );
    }

    if (results.length < 2) {
      logJudge("request.skipped", {
        runId,
        turnId,
        reason: "fewer_than_two_completed_lanes",
        completedCount: results.length,
      });

      return Response.json({
        skipped: true,
        reason: "Judge skipped because fewer than two lanes completed.",
      });
    }

    logJudge("runner.import.start", { runId, turnId });
    const { runJudge } = await import("@/lib/judge/runJudge");
    logJudge("runner.import.success", { runId, turnId });
    const result = await runJudge({
      runId,
      prompt,
      results,
      failed,
      specification: bootstrap.specifications.judge,
    });

    logJudge("request.completed", {
      runId,
      turnId,
      winnerLaneId: result.winnerLaneId,
      scoredLaneCount: result.lanes.length,
      scoredLanes: result.lanes.map((lane) => ({
        anonymousId: lane.anonymousId,
        laneId: lane.laneId,
        overallScore: lane.overallScore,
      })),
    });

    return Response.json({ result });
  } catch (error) {
    const message = errorMessage(error);

    logJudge("request.failed", { runId, turnId, error: message });

    return Response.json({ error: message }, { status: 500 });
  }
}
