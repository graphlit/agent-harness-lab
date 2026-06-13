import { NextRequest } from "next/server";
import { z } from "zod";

import {
  DEFAULT_MODEL_SIZE,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYSTEM_PROMPT_ENABLED,
  LANE_LABELS,
  SYSTEM_PROMPT,
  createRuntimeInstructions,
} from "@/lib/constants";
import {
  type LabRunEvent,
  type LaneId,
  type LaneRunContext,
  type LaneRunResult,
  type LaneSessionState,
  type ModelProviderPreference,
  type ModelSize,
  type ReasoningEffort,
} from "@/lib/types";
import { createId, errorMessage } from "@/lib/utils";

const LANE_RUN_TIMEOUT_MS = 180_000;

const LaneRunRequestSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  reasoningEffort: z
    .enum(["low", "medium", "high"])
    .default(DEFAULT_REASONING_EFFORT),
  modelProvider: z
    .enum(["openai", "anthropic", "google"])
    .default(DEFAULT_MODEL_PROVIDER),
  modelSize: z.enum(["large", "small"]).default(DEFAULT_MODEL_SIZE),
  systemPromptEnabled: z.boolean().default(DEFAULT_SYSTEM_PROMPT_ENABLED),
  runtimeUtc: z.string().datetime().optional(),
  laneSession: z.record(z.string(), z.unknown()).default({}),
});

type LaneRunner = (context: LaneRunContext) => Promise<LaneRunResult>;
type LaneRunnerLoader = () => Promise<LaneRunner>;

function logLaneRoute(
  laneId: LaneId,
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(
    `[agent-harness-lab/api/lanes/${laneId}] ${phase}`,
    details ?? {},
  );
}

function createNdjsonStream(
  run: (emit: (event: LabRunEvent) => Promise<void>) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let writeQueue = Promise.resolve();

      const emit = async (event: LabRunEvent) => {
        writeQueue = writeQueue.then(() =>
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
        );
        await writeQueue;
      };

      void run(emit)
        .catch((error) => {
          console.error("[agent-harness-lab/api/lanes] stream.failed", {
            error: errorMessage(error),
          });
        })
        .finally(async () => {
          await writeQueue;
          controller.close();
        });
    },
  });
}

async function withAbortableTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const abortPromise = new Promise<never>((_, reject) => {
    const fail = (reason: unknown) => {
      const error =
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : message);

      if (!controller.signal.aborted) {
        controller.abort(error);
      }

      reject(error);
    };

    timeoutId = setTimeout(() => fail(new Error(message)), timeoutMs);

    if (parentSignal) {
      const onAbort = () =>
        fail(parentSignal.reason ?? new Error("Lane request was aborted."));

      if (parentSignal.aborted) {
        onAbort();
      } else {
        parentSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          parentSignal.removeEventListener("abort", onAbort);
      }
    }
  });

  try {
    return await Promise.race([start(controller.signal), abortPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    removeAbortListener?.();
  }
}

export function createLaneRoute(laneId: LaneId, loadLaneRunner: LaneRunnerLoader) {
  return async function POST(request: NextRequest) {
    const body = await request.json();
    const parsed = LaneRunRequestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ error: parsed.error.message }, { status: 400 });
    }

    const runId = parsed.data.runId ?? createId("run");
    const sessionId = parsed.data.sessionId ?? createId("session");
    const turnId = parsed.data.turnId;
    const prompt = parsed.data.prompt;
    const reasoningEffort = parsed.data.reasoningEffort as ReasoningEffort;
    const modelProvider = parsed.data
      .modelProvider as ModelProviderPreference;
    const modelSize = parsed.data.modelSize as ModelSize;
    const systemPromptEnabled = parsed.data.systemPromptEnabled;
    const runtimeContext = createRuntimeInstructions(
      parsed.data.runtimeUtc ?? new Date(),
    );
    const laneSession = parsed.data.laneSession as LaneSessionState;

    logLaneRoute(laneId, "request.received", {
      runId,
      turnId,
      sessionId,
      reasoningEffort,
      modelProvider,
      modelSize,
      systemPromptEnabled,
      runtimeUtc: runtimeContext.currentUtc,
    });

    const stream = createNdjsonStream(async (emit) => {
      await emit({ type: "run_started", runId, turnId, prompt });
      await emit({ type: "lane_started", runId, turnId, laneId });

      try {
        logLaneRoute(laneId, "bootstrap.import.start", { runId, turnId });
        const { bootstrapAgentHarnessLab } = await import(
          "@/lib/graphlit/bootstrap"
        );
        logLaneRoute(laneId, "bootstrap.import.success", { runId, turnId });
        logLaneRoute(laneId, "bootstrap.start", { runId, turnId });
        const bootstrap = await bootstrapAgentHarnessLab();
        logLaneRoute(laneId, "bootstrap.complete", {
          runId,
          turnId,
          ready: bootstrap.graphlit.ready,
          bootstrapUpToDate: bootstrap.bootstrapUpToDate,
        });

        const readiness = bootstrap.lanes[laneId];

        if (!readiness.enabled) {
          const error =
            readiness.reason ?? `${LANE_LABELS[laneId]} is disabled.`;

          logLaneRoute(laneId, "lane.disabled", { runId, turnId, error });
          await emit({ type: "lane_failed", runId, turnId, laneId, error });
          await emit({ type: "run_completed", runId, turnId });
          return;
        }

        await emit({
          type: "lane_trace",
          runId,
          turnId,
          laneId,
          event: {
            phase: "lane.invoke.start",
            laneId,
            modelSize,
            modelProvider,
            reasoningEffort,
            systemPromptEnabled,
            runtimeUtc: runtimeContext.currentUtc,
            runtimeInstructionsProvided: true,
          },
        });
        logLaneRoute(laneId, "lane.invoke.start", { runId, turnId });
        logLaneRoute(laneId, "lane.import.start", { runId, turnId });
        const runLane = await loadLaneRunner();
        logLaneRoute(laneId, "lane.import.success", { runId, turnId });

        const result = await withAbortableTimeout(
          (abortSignal) =>
            runLane({
              runId,
              turnId,
              sessionId,
              prompt,
              reasoningEffort,
              modelProvider,
              modelSize,
              systemPrompt: systemPromptEnabled ? SYSTEM_PROMPT : undefined,
              runtimeInstructions: runtimeContext.text,
              runtimeUtc: runtimeContext.currentUtc,
              emit,
              abortSignal,
              laneSession,
              graphlitSpecification:
                laneId === "graphlit"
                  ? bootstrap.specifications.graphlit?.[modelProvider]?.[
                      modelSize
                    ]?.[reasoningEffort]
                  : undefined,
            }),
          request.signal,
          LANE_RUN_TIMEOUT_MS,
          `Timed out running ${LANE_LABELS[laneId]} after ${LANE_RUN_TIMEOUT_MS}ms.`,
        );

        if (result.error) {
          logLaneRoute(laneId, "lane.failed", {
            runId,
            turnId,
            error: result.error,
          });
          await emit({
            type: "lane_failed",
            runId,
            turnId,
            laneId,
            error: result.error,
          });
        } else {
          logLaneRoute(laneId, "lane.completed", {
            runId,
            turnId,
            durationMs: result.durationMs,
            toolCalls: result.toolCalls.length,
          });
          await emit({
            type: "lane_completed",
            runId,
            turnId,
            laneId,
            result,
          });
        }
      } catch (error) {
        const message = errorMessage(error);

        logLaneRoute(laneId, "lane.failed", { runId, turnId, error: message });
        await emit({
          type: "lane_failed",
          runId,
          turnId,
          laneId,
          error: message,
        });
      }

      await emit({ type: "run_completed", runId, turnId });
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  };
}
