import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Types } from "graphlit-client";

import {
  AGENT_MAX_STEPS,
  AGENT_HARNESS_LAB_BOOTSTRAP_VERSION,
  DEFAULT_LANES,
  DEFAULT_MODEL_TEMPERATURE,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_MODEL_SIZE,
  DEFAULT_REASONING_EFFORT,
  GRAPHLIT_SPEC_NAMES,
  JUDGE_SPEC_NAME,
  LONG_RUNNING_TEST_TIMEOUT_MS,
  MODEL_PROVIDER_PREFERENCES,
} from "@/lib/constants";
import {
  LANE_IDS,
  type BootstrapSpecificationRef,
  type BootstrapStatus,
  type GraphlitEffortSpecifications,
  type GraphlitModelSpecifications,
  type GraphlitProviderSpecifications,
  type LaneId,
  type ModelProviderPreference,
  type ModelSize,
  type ReasoningEffort,
  type StoredBootstrapState,
} from "@/lib/types";
import {
  createGraphlitClient,
  getGraphlitClientDiagnostics,
  getGraphlitCredentialError,
} from "@/lib/graphlit/client";
import {
  getModelProviderApiKey,
  hasAnyModelProviderApiKey,
  modelProviderKeyName,
} from "@/lib/model-provider-keys";

const BOOTSTRAP_STATE_DIR = ".graphlit-agent-harness-lab";
const BOOTSTRAP_STATE_FILE = "bootstrap-state.json";
const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const MODEL_SIZES: ModelSize[] = ["large", "small"];
const MODEL_PROVIDERS = MODEL_PROVIDER_PREFERENCES;
const ANTHROPIC_THINKING_TOKEN_LIMIT = 4_096;
const DEFAULT_GRAPHLIT_OPERATION_TIMEOUT_MS = LONG_RUNNING_TEST_TIMEOUT_MS;
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

function configuredDefaultModelProvider(): ModelProviderPreference {
  const value = process.env.AGENT_HARNESS_LAB_MODEL_PROVIDER;
  const configured =
    value === "openai" || value === "anthropic" || value === "google"
      ? value
      : DEFAULT_MODEL_PROVIDER;
  const configuredHasKey = Boolean(getModelProviderApiKey(configured));

  if (configuredHasKey) {
    return configured;
  }

  return (
    MODEL_PROVIDERS.find((provider) => getModelProviderApiKey(provider)) ??
    configured
  );
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

function mapAnthropicEffort(
  effort: ReasoningEffort,
): Types.AnthropicEffortLevels {
  switch (effort) {
    case "low":
      return Types.AnthropicEffortLevels.Low;
    case "high":
      return Types.AnthropicEffortLevels.High;
    case "medium":
    default:
      return Types.AnthropicEffortLevels.Medium;
  }
}

function mapGoogleThinkingLevel(
  effort: ReasoningEffort,
  modelSize: ModelSize,
): Types.GoogleThinkingLevels {
  switch (effort) {
    case "low":
      return Types.GoogleThinkingLevels.Low;
    case "medium":
      return modelSize === "small"
        ? Types.GoogleThinkingLevels.Medium
        : Types.GoogleThinkingLevels.High;
    case "high":
    default:
      return Types.GoogleThinkingLevels.High;
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
  provider: ModelProviderPreference,
  effort: ReasoningEffort,
  modelSize: ModelSize,
): Types.SpecificationInput {
  const base = {
    name: GRAPHLIT_SPEC_NAMES[provider][modelSize][effort],
    type: Types.SpecificationTypes.Agentic,
    systemPrompt: null,
    searchType: Types.ConversationSearchTypes.None,
    strategy: {
      enableSummarization: false,
      enableEntityExtraction: false,
      enableFactExtraction: false,
      toolRoundLimit: AGENT_MAX_STEPS,
      toolResultTokenLimit: 6_000,
    },
  };

  if (provider === "anthropic") {
    return {
      ...base,
      serviceType: Types.ModelServiceTypes.Anthropic,
      anthropic: {
        model:
          modelSize === "large"
            ? Types.AnthropicModels.Claude_4_8Opus
            : Types.AnthropicModels.Claude_4_6Sonnet,
        temperature: DEFAULT_MODEL_TEMPERATURE,
        effort: mapAnthropicEffort(effort),
        enableThinking: effort !== "low",
        thinkingTokenLimit:
          effort === "low" ? undefined : ANTHROPIC_THINKING_TOKEN_LIMIT,
      },
    };
  }

  if (provider === "google") {
    return {
      ...base,
      serviceType: Types.ModelServiceTypes.Google,
      google: {
        model:
          modelSize === "large"
            ? Types.GoogleModels.Gemini_3ProPreview
            : Types.GoogleModels.GeminiFlashLatest,
        temperature: DEFAULT_MODEL_TEMPERATURE,
        enableThinking: true,
        thinkingLevel: mapGoogleThinkingLevel(effort, modelSize),
      },
    };
  }

  return {
    ...base,
    serviceType: Types.ModelServiceTypes.OpenAi,
    openAI: {
      model:
        modelSize === "large"
          ? Types.OpenAiModels.Gpt55_1024K
          : Types.OpenAiModels.Gpt5Mini_400K,
      temperature: DEFAULT_MODEL_TEMPERATURE,
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
      temperature: DEFAULT_MODEL_TEMPERATURE,
      enableThinking: true,
      thinkingLevel: Types.GoogleThinkingLevels.High,
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
  const hasProviderKey = hasAnyModelProviderApiKey();
  const graphlitReason = "Graphlit credentials are required.";
  const providerKeyReason =
    "OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY is required.";

  return {
    graphlit: {
      enabled: graphlitReady && hasProviderKey,
      reason: graphlitReady
        ? hasProviderKey
          ? undefined
          : providerKeyReason
        : graphlitReason,
    },
    openai: {
      enabled: graphlitReady && Boolean(process.env.OPENAI_API_KEY),
      reason: graphlitReady
        ? process.env.OPENAI_API_KEY
          ? undefined
          : "OPENAI_API_KEY is required."
        : graphlitReason,
    },
    vercel: {
      enabled: graphlitReady && hasProviderKey,
      reason: graphlitReady
        ? hasProviderKey
          ? undefined
          : providerKeyReason
        : graphlitReason,
    },
    langgraph: {
      enabled: graphlitReady && hasProviderKey,
      reason: graphlitReady
        ? hasProviderKey
          ? undefined
          : providerKeyReason
        : graphlitReason,
    },
    mastra: {
      enabled: graphlitReady && hasProviderKey,
      reason: graphlitReady
        ? hasProviderKey
          ? undefined
          : providerKeyReason
        : graphlitReason,
    },
    claude: {
      enabled: graphlitReady && Boolean(process.env.ANTHROPIC_API_KEY),
      reason: graphlitReady
        ? process.env.ANTHROPIC_API_KEY
          ? undefined
          : "ANTHROPIC_API_KEY is required."
        : graphlitReason,
    },
    google: {
      enabled: graphlitReady && Boolean(process.env.GEMINI_API_KEY),
      reason: graphlitReady
        ? process.env.GEMINI_API_KEY
          ? undefined
          : "GEMINI_API_KEY is required."
        : graphlitReason,
    },
  };
}

function buildModelProviderReadiness(): BootstrapStatus["modelProviders"] {
  return Object.fromEntries(
    MODEL_PROVIDERS.map((provider) => {
      const keyName = modelProviderKeyName(provider);
      const enabled = Boolean(getModelProviderApiKey(provider));

      return [
        provider,
        {
          enabled,
          reason: enabled ? undefined : `${keyName} is required.`,
        },
      ];
    }),
  ) as BootstrapStatus["modelProviders"];
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

  return Object.fromEntries(
    LANE_IDS.map((laneId) => [
      laneId,
      laneId === "graphlit" || defaultSet.has(laneId)
        ? lanes[laneId]
        : { enabled: false, reason: "Disabled by NEXT_PUBLIC_DEFAULT_LANES." },
    ]),
  ) as BootstrapStatus["lanes"];
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
  const defaultModelProvider = configuredDefaultModelProvider();
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
    defaultModelProvider,
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
      defaultModelProvider,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: false, error: credentialError },
      modelProviders: buildModelProviderReadiness(),
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
      defaultModelProvider,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: false, error: message },
      modelProviders: buildModelProviderReadiness(),
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: false, reason: message },
    };
  }

  const bootstrapUpToDate =
    storedState.bootstrapVersion === AGENT_HARNESS_LAB_BOOTSTRAP_VERSION &&
    Boolean(storedState.specifications.judge?.id) &&
    MODEL_PROVIDERS.every((provider) =>
      MODEL_SIZES.every((modelSize) =>
        REASONING_EFFORTS.every(
          (effort) =>
            storedState.specifications.graphlit?.[provider]?.[modelSize]?.[
              effort
            ]?.id,
        ),
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
      defaultModelProvider,
      defaultModelSize,
      bootstrapUpToDate: true,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: true },
      modelProviders: buildModelProviderReadiness(),
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: true },
    };
  }

  const graphlitSpecs = {} as GraphlitProviderSpecifications;

  try {
    for (const provider of MODEL_PROVIDERS) {
      graphlitSpecs[provider] = {} as GraphlitModelSpecifications;

      for (const modelSize of MODEL_SIZES) {
        graphlitSpecs[provider][modelSize] = {} as GraphlitEffortSpecifications;

        for (const effort of REASONING_EFFORTS) {
          const specName = GRAPHLIT_SPEC_NAMES[provider][modelSize][effort];
          logBootstrap("upsertSpecification.start", {
            specName,
            provider,
            modelSize,
            effort,
          });
          const upserted = await withGraphlitTimeout(
            client.upsertSpecification(
              buildGraphlitSpecification(provider, effort, modelSize),
            ),
            `upsertSpecification(${specName})`,
            diagnostics.apiUri,
          );
          graphlitSpecs[provider][modelSize][effort] = toSpecRef(
            upserted.upsertSpecification,
            specName,
          );
          logBootstrap("upsertSpecification.success", {
            specName,
            id: graphlitSpecs[provider][modelSize][effort].id,
          });
        }
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
      defaultModelProvider,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: true,
      warning: [readWarning, writeWarning].filter(Boolean).join(" ") || undefined,
      graphlit: { ready: true },
      modelProviders: buildModelProviderReadiness(),
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
      defaultModelProvider,
      defaultModelSize,
      bootstrapUpToDate: false,
      rebootstrapPerformed: false,
      warning: readWarning,
      graphlit: { ready: false, error: message },
      modelProviders: buildModelProviderReadiness(),
      specifications: storedState.specifications,
      lanes,
      judge: { enabled: false, reason: message },
    };
  }
}

export async function getBootstrappedSpecification(
  effort: ReasoningEffort,
  modelProvider: ModelProviderPreference = DEFAULT_MODEL_PROVIDER,
  modelSize: ModelSize = DEFAULT_MODEL_SIZE,
): Promise<BootstrapSpecificationRef> {
  const status = await bootstrapAgentHarnessLab();
  const spec =
    status.specifications.graphlit?.[modelProvider]?.[modelSize]?.[effort];

  if (!status.graphlit.ready) {
    throw new Error(status.graphlit.error ?? "Graphlit project is not ready.");
  }

  if (!spec?.id) {
    throw new Error(
      `Graphlit ${modelProvider} ${modelSize} ${effort} specification is not bootstrapped.`,
    );
  }

  return spec;
}
