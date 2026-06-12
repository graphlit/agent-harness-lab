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
      completed: results.map((result) => result.laneId),
      failed,
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
      return Response.json(
        { error: "Judge requires at least two completed lanes." },
        { status: 400 },
      );
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

    logJudge("request.completed", { runId, turnId });

    return Response.json({ result });
  } catch (error) {
    const message = errorMessage(error);

    logJudge("request.failed", { runId, turnId, error: message });

    return Response.json({ error: message }, { status: 500 });
  }
}
