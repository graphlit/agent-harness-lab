import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Types } from "graphlit-client";

import {
  AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
  DEFAULT_LANES,
  DEFAULT_MODEL_SIZE,
  DEFAULT_REASONING_EFFORT,
  GRAPHLIT_SPEC_NAMES,
  JUDGE_SPEC_NAME,
  SYSTEM_PROMPT,
} from "@/lib/constants";
import {
  type BootstrapSpecificationRef,
  type BootstrapStatus,
  type GraphlitEffortSpecifications,
  type GraphlitModelSpecifications,
  type LaneId,
  type ModelSize,
  type ReasoningEffort,
  type StoredBootstrapState,
} from "@/lib/types";
import {
  createGraphlitClient,
  getGraphlitClientDiagnostics,
  getGraphlitCredentialError,
} from "@/lib/graphlit/client";

const BOOTSTRAP_STATE_DIR = ".graphlit-agent-harness-lab";
const BOOTSTRAP_STATE_FILE = "bootstrap-state.json";
const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const MODEL_SIZES: ModelSize[] = ["large", "small"];
const DEFAULT_GRAPHLIT_OPERATION_TIMEOUT_MS = 15_000;
let bootstrapAgentHarnessLabPromise: Promise<BootstrapStatus> | null = null;

function elapsed(startedAt: number): string {
  return `${Date.now() - startedAt}ms`;
}

function logBootstrap(
  phase: string,
  details?: Record<string, unknown>,
): void {
  console.info(`[agent-harness-lab/bootstrap] ${phase}`, details ?? {});
}

function logBootstrapError(
  phase: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  console.error(`[agent-harness-lab/bootstrap] ${phase}`, {
    ...details,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : String(error),
  });
}

function configuredGraphlitOperationTimeoutMs(): number {
  const configured = Number(process.env.AGENT_HARNESS_LAB_GRAPHLIT_TIMEOUT_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GRAPHLIT_OPERATION_TIMEOUT_MS;
}

async function withGraphlitTimeout<T>(
  operation: Promise<T>,
  operationName: string,
  apiUri: unknown,
): Promise<T> {
  const timeoutMs = configuredGraphlitOperationTimeoutMs();
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms while calling Graphlit ${operationName} at ${String(apiUri)}. Check GRAPHLIT_API_URL and network access.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function configuredDefaultReasoningEffort(): ReasoningEffort {
  const value = process.env.AGENT_HARNESS_LAB_REASONING_EFFORT;

  return value === "low" || value === "medium" || value === "high"
    ? value
    : DEFAULT_REASONING_EFFORT;
}

function configuredDefaultModelSize(): ModelSize {
  const value = process.env.AGENT_HARNESS_LAB_MODEL_SIZE;

  return value === "large" || value === "small" ? value : DEFAULT_MODEL_SIZE;
}

function mapOpenAiReasoningEffort(
  effort: ReasoningEffort,
): Types.OpenAiReasoningEffortLevels {
  switch (effort) {
    case "low":
      return Types.OpenAiReasoningEffortLevels.Low;
    case "high":
      return Types.OpenAiReasoningEffortLevels.High;
    case "medium":
    default:
      return Types.OpenAiReasoningEffortLevels.Medium;
  }
}

function bootstrapStatePath(): string {
  const configuredRoot = process.env.AGENT_HARNESS_LAB_STATE_DIR?.trim();
  const root =
    configuredRoot ||
    path.join(os.tmpdir(), BOOTSTRAP_STATE_DIR);
  const stateKey = createHash("sha1")
    .update(
      [
        process.cwd(),
        process.env.GRAPHLIT_API_URL ?? "",
        process.env.GRAPHLIT_ORGANIZATION_ID ?? "",
        process.env.GRAPHLIT_ENVIRONMENT_ID ?? "",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);

  return path.join(root, stateKey, BOOTSTRAP_STATE_FILE);
}

async function readStoredBootstrapState(): Promise<{
  state: StoredBootstrapState;
  warning?: string;
}> {
  try {
    const raw = await readFile(bootstrapStatePath(), "utf8");
    const parsed = JSON.parse(raw) as StoredBootstrapState;

    return {
      state: {
        bootstrapVersion: parsed.bootstrapVersion ?? null,
        specifications: parsed.specifications ?? {},
        updatedAt: parsed.updatedAt,
      },
    };
  } catch (error) {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;

    if (code === "ENOENT") {
      return {
        state: {
          bootstrapVersion: null,
          specifications: {},
        },
      };
    }

    return {
      state: {
        bootstrapVersion: null,
        specifications: {},
      },
      warning: `Could not read bootstrap state; rebootstrap will run. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function writeStoredBootstrapState(
  state: StoredBootstrapState,
): Promise<string | undefined> {
  try {
    await mkdir(path.dirname(bootstrapStatePath()), { recursive: true });
    await writeFile(bootstrapStatePath(), `${JSON.stringify(state, null, 2)}\n`);
    return undefined;
  } catch (error) {
    return `Bootstrap succeeded but state was not persisted. ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildGraphlitSpecification(
  effort: ReasoningEffort,
  modelSize: ModelSize,
): Types.SpecificationInput {
  return {
    name: GRAPHLIT_SPEC_NAMES[modelSize][effort],
    type: Types.SpecificationTypes.Agentic,
    serviceType: Types.ModelServiceTypes.OpenAi,
    systemPrompt: SYSTEM_PROMPT,
    searchType: Types.ConversationSearchTypes.None,
    strategy: {
      enableSummarization: true,
      enableEntityExtraction: true,
      enableFactExtraction: false,
      toolRoundLimit: 8,
      toolResultTokenLimit: 6_000,
    },
    openAI: {
      model:
        modelSize === "large"
          ? Types.OpenAiModels.Gpt55_1024K
          : Types.OpenAiModels.Gpt5Mini_400K,
      temperature: 0.2,
      completionTokenLimit: 1_600,
      reasoningEffort: mapOpenAiReasoningEffort(effort),
    },
  };
}

function buildJudgeSpecification(): Types.SpecificationInput {
  return {
    name: JUDGE_SPEC_NAME,
    type: Types.SpecificationTypes.Extraction,
    serviceType: Types.ModelServiceTypes.Google,
    google: {
      model: Types.GoogleModels.Gemini_3_5Flash,
      temperature: 0,
      completionTokenLimit: 2_000,
    },
  };
}

function toSpecRef(
  spec: { id?: string | null; name?: string | null } | null | undefined,
  fallbackName: string,
): BootstrapSpecificationRef {
  if (!spec?.id) {
    throw new Error(`Failed to upsert specification: ${fallbackName}`);
  }

  return {
    id: spec.id,
    name: spec.name ?? fallbackName,
  };
}

function buildLaneReadiness(graphlitReady: boolean): BootstrapStatus["lanes"] {
  return {
    graphlit: {
      enabled: graphlitReady,
      reason: graphlitReady ? undefined : "Graphlit credentials are required.",
    },
    openai: {
      enabled: graphlitReady && Boolean(process.env.OPENAI_API_KEY),
      reason: process.env.OPENAI_API_KEY
        ? undefined
        : "OPENAI_API_KEY is required.",
    },
    mastra: {
      enabled: graphlitReady && Boolean(process.env.OPENAI_API_KEY),
      reason: process.env.OPENAI_API_KEY
        ? undefined
        : "OPENAI_API_KEY is required.",
    },
    claude: {
      enabled: graphlitReady && Boolean(process.env.ANTHROPIC_API_KEY),
      reason: process.env.ANTHROPIC_API_KEY
        ? undefined
        : "ANTHROPIC_API_KEY is required.",
    },
    google: {
      enabled: graphlitReady && Boolean(process.env.GEMINI_API_KEY),
      reason: process.env.GEMINI_API_KEY
        ? undefined
        : "GEMINI_API_KEY is required.",
    },
  };
}

function normalizeDefaultLanes(
  lanes: BootstrapStatus["lanes"],
): BootstrapStatus["lanes"] {
  const configured = process.env.NEXT_PUBLIC_DEFAULT_LANES?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) as LaneId[] | undefined;
  const defaultSet = new Set<LaneId>(
    configured?.length ? configured : DEFAULT_LANES,
  );

  return {
    graphlit: lanes.graphlit,
    openai: defaultSet.has("openai")
      ? lanes.openai
      : { enabled: false, reason: "Disabled by NEXT_PUBLIC_DEFAULT_LANES." },
    mastra: defaultSet.has("mastra")
      ? lanes.mastra
      : { enabled: false, reason: "Disabled by NEXT_PUBLIC_DEFAULT_LANES." },
    claude: defaultSet.has("claude")
      ? lanes.claude
      : { enabled: false, reason: "Disabled by NEXT_PUBLIC_DEFAULT_LANES." },
    google: defaultSet.has("google")
      ? lanes.google
      : { enabled: false, reason: "Disabled by NEXT_PUBLIC_DEFAULT_LANES." },
  };
}

export function bootstrapAgentHarnessLab(): Promise<BootstrapStatus> {
  if (bootstrapAgentHarnessLabPromise) {
    logBootstrap("singleFlight.join");
    return bootstrapAgentHarnessLabPromise;
  }

  logBootstrap("singleFlight.start");
  bootstrapAgentHarnessLabPromise = runBootstrapAgentHarnessLab().finally(() => {
    bootstrapAgentHarnessLabPromise = null;
  });

  return bootstrapAgentHarnessLabPromise;
}

async function runBootstrapAgentHarnessLab(): Promise<BootstrapStatus> {
  const startedAt = Date.now();
  const credentialError = getGraphlitCredentialError();
  const diagnostics = getGraphlitClientDiagnostics();
  const defaultReasoningEffort = configuredDefaultReasoningEffort();
  const defaultModelSize = configuredDefaultModelSize();
  const statePath = bootstrapStatePath();
  const stateReadStartedAt = Date.now();

  logBootstrap("readState.start", {
    bootstrapStatePath: statePath,
  });

  const { state: storedState, warning: readWarning } =
    await readStoredBootstrapState();

  logBootstrap("readState.complete", {
    elapsed: elapsed(stateReadStartedAt),
    bootstrapStatePath: statePath,
    storedBootstrapVersion: storedState.bootstrapVersion,
    readWarning,
  });

  logBootstrap("start", {
    diagnostics,
    graphlitOperationTimeoutMs: configuredGraphlitOperationTimeoutMs(),
    targetBootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
    storedBootstrapVersion: storedState.bootstrapVersion,
    defaultReasoningEffort,
    defaultModelSize,
    readWarning,
  });

  if (credentialError) {
    const lanes = normalizeDefaultLanes(buildLaneReadiness(false));

    logBootstrap("credentials.missing", {
      credentialError,
      diagnostics,
      elapsed: elapsed(startedAt),
    });

    return {
      targetBootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
      storedBootstrapVersion: storedState.bootstrapVersion,
      defaultReasoningEffort,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: false, error: credentialError },
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: false, reason: credentialError },
    };
  }

  const client = createGraphlitClient();

  try {
    logBootstrap("getProject.start", {
      apiUri: diagnostics.apiUri,
    });
    await withGraphlitTimeout(
      client.getProject(),
      "getProject",
      diagnostics.apiUri,
    );
    logBootstrap("getProject.success", {
      elapsed: elapsed(startedAt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lanes = normalizeDefaultLanes(buildLaneReadiness(false));

    logBootstrapError("getProject.failed", error, {
      diagnostics,
      elapsed: elapsed(startedAt),
    });

    return {
      targetBootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
      storedBootstrapVersion: storedState.bootstrapVersion,
      defaultReasoningEffort,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: false, error: message },
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: false, reason: message },
    };
  }

  const bootstrapUpToDate =
    storedState.bootstrapVersion === AGENT_HARNESS_LAB_BOOTSTRAP_VERSION &&
    Boolean(storedState.specifications.judge?.id) &&
    MODEL_SIZES.every((modelSize) =>
      REASONING_EFFORTS.every(
        (effort) => storedState.specifications.graphlit?.[modelSize]?.[effort]?.id,
      ),
    );

  if (bootstrapUpToDate) {
    const lanes = normalizeDefaultLanes(buildLaneReadiness(true));

    logBootstrap("upToDate", {
      elapsed: elapsed(startedAt),
    });

    return {
      targetBootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
      storedBootstrapVersion: storedState.bootstrapVersion,
      defaultReasoningEffort,
      defaultModelSize,
      bootstrapUpToDate: true,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: true },
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: true },
    };
  }

  const graphlitSpecs = {} as GraphlitModelSpecifications;

  try {
    for (const modelSize of MODEL_SIZES) {
      graphlitSpecs[modelSize] = {} as GraphlitEffortSpecifications;

      for (const effort of REASONING_EFFORTS) {
        const specName = GRAPHLIT_SPEC_NAMES[modelSize][effort];
        logBootstrap("upsertSpecification.start", {
          specName,
          modelSize,
          effort,
        });
        const upserted = await withGraphlitTimeout(
          client.upsertSpecification(
            buildGraphlitSpecification(effort, modelSize),
          ),
          `upsertSpecification(${specName})`,
          diagnostics.apiUri,
        );
        graphlitSpecs[modelSize][effort] = toSpecRef(
          upserted.upsertSpecification,
          specName,
        );
        logBootstrap("upsertSpecification.success", {
          specName,
          id: graphlitSpecs[modelSize][effort].id,
        });
      }
    }

    logBootstrap("upsertJudge.start", {
      specName: JUDGE_SPEC_NAME,
    });
    const judgeUpserted = await withGraphlitTimeout(
      client.upsertSpecification(buildJudgeSpecification()),
      `upsertSpecification(${JUDGE_SPEC_NAME})`,
      diagnostics.apiUri,
    );
    const judge = toSpecRef(judgeUpserted.upsertSpecification, JUDGE_SPEC_NAME);
    logBootstrap("upsertJudge.success", {
      specName: JUDGE_SPEC_NAME,
      id: judge.id,
    });
    const nextState: StoredBootstrapState = {
      bootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
      specifications: {
        graphlit: graphlitSpecs,
        judge,
      },
      updatedAt: new Date().toISOString(),
    };
    const writeWarning = await writeStoredBootstrapState(nextState);
    const lanes = normalizeDefaultLanes(buildLaneReadiness(true));

    logBootstrap("complete", {
      elapsed: elapsed(startedAt),
      writeWarning,
    });

    return {
      targetBootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
      storedBootstrapVersion: storedState.bootstrapVersion,
      defaultReasoningEffort,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: true,
      warning: [readWarning, writeWarning].filter(Boolean).join(" ") || undefined,
      graphlit: { ready: true },
      specifications: nextState.specifications,
      lanes,
      judge: { enabled: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lanes = normalizeDefaultLanes(buildLaneReadiness(false));

    logBootstrapError("bootstrapSpecifications.failed", error, {
      diagnostics,
      elapsed: elapsed(startedAt),
    });

    return {
      targetBootstrapVersion: AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
      storedBootstrapVersion: storedState.bootstrapVersion,
      defaultReasoningEffort,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: false, error: message },
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: false, reason: message },
    };
  }
}

export async function getBootstrappedSpecification(
  effort: ReasoningEffort,
  modelSize: ModelSize = DEFAULT_MODEL_SIZE,
): Promise<BootstrapSpecificationRef> {
  const status = await bootstrapAgentHarnessLab();
  const spec = status.specifications.graphlit?.[modelSize]?.[effort];

  if (!status.graphlit.ready) {
    throw new Error(status.graphlit.error ?? "Graphlit project is not ready.");
  }

  if (!spec?.id) {
    throw new Error(
      `Graphlit ${modelSize} ${effort} specification is not bootstrapped.`,
    );
  }

  return spec;
}
