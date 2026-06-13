"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Globe,
  Hash,
  Info,
  Loader2,
  Moon,
  Paperclip,
  RotateCcw,
  Send,
  Sun,
  X,
} from "lucide-react";
import type {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import JSONPretty from "react-json-pretty";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { BrandIcon } from "@/components/BrandIcon";
import {
  DEFAULT_LANES,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_MODEL_SIZE,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYSTEM_PROMPT_ENABLED,
  LANE_LABELS,
  LANE_STREAM_LABELS,
  LANE_STREAM_TITLES,
  MODEL_PROVIDER_LABELS,
  MODEL_PROVIDER_PREFERENCES,
  SYSTEM_PROMPT,
  getLaneModelLabel,
} from "@/lib/constants";
import {
  LANE_IDS,
  type BootstrapStatus,
  type JudgeResult,
  type LabRunEvent,
  type LaneId,
  type LaneRunResult,
  type LaneSessionState,
  type LaneStatus,
  type ModelProviderPreference,
  type ModelSize,
  type ReasoningEffort,
  type SourceTrace,
  type ToolCallTrace,
  type TokenUsageTrace,
} from "@/lib/types";

type LaneTurnUiState = {
  turnId: string;
  prompt: string;
  status: LaneStatus;
  startedAt: string;
  completedAt?: string;
  answer: string;
  reasoning: string;
  toolCalls: ToolCallTrace[];
  sources: SourceTrace[];
  rawEvents: unknown[];
  error?: string;
  result?: LaneRunResult;
};

type LaneUiState = {
  id: LaneId;
  session: LaneSessionState;
  turns: LaneTurnUiState[];
};

type JudgeUiState = {
  status: "idle" | "running" | "completed" | "failed";
  turnId?: string;
  result?: JudgeResult;
  error?: string;
};

type ColorTheme = "dark" | "light";

const PROMPT_HISTORY_KEY = "agent-harness-lab-prompt-history";
const MAX_PROMPT_HISTORY = 50;
const LANE_START_TIMEOUT_MS = 45_000;
const JUDGE_CLIENT_TIMEOUT_MS = 120_000;

const initialTurnState = (
  turnId: string,
  prompt: string,
  status: LaneStatus = "idle",
): LaneTurnUiState => ({
  turnId,
  prompt,
  status,
  startedAt: new Date().toISOString(),
  answer: "",
  reasoning: "",
  toolCalls: [],
  sources: [],
  rawEvents: [],
});

const initialLaneState = (id: LaneId): LaneUiState => ({
  id,
  session: {},
  turns: [],
});

type BootstrapFetchResult = {
  ok: boolean;
  status: number;
  statusText: string;
  elapsedMs: number;
  body: BootstrapStatus | { error?: string };
};

type IngestApiResult = {
  type: "uri" | "file";
  contentId: string;
  name: string;
  ready: boolean;
  message: string;
};

type IngestUiStatus = {
  state: "running" | "ready" | "pending" | "error";
  kind?: "uri" | "file";
  message: string;
};

let bootstrapFetchPromise: Promise<BootstrapFetchResult> | null = null;

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function formatControlValue(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function browserErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function isIngestApiResult(value: unknown): value is IngestApiResult {
  return (
    isRecord(value) &&
    (value.type === "uri" || value.type === "file") &&
    typeof value.contentId === "string" &&
    typeof value.name === "string" &&
    typeof value.ready === "boolean" &&
    typeof value.message === "string"
  );
}

async function readIngestApiResult(response: Response): Promise<IngestApiResult> {
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : response.statusText;

    throw new Error(message || "Failed to ingest content into Graphlit.");
  }

  if (!isIngestApiResult(body)) {
    throw new Error("Graphlit ingest returned an unexpected response.");
  }

  return body;
}

function createClientId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `${prefix}-${random}`;
}

function laneHasTranscript(lane: LaneUiState): boolean {
  return lane.turns.length > 0;
}

function updateLaneTurn(
  state: LaneUiState,
  turnId: string,
  update: (turn: LaneTurnUiState) => LaneTurnUiState,
): LaneUiState {
  const index = state.turns.findIndex((turn) => turn.turnId === turnId);
  const turns = [...state.turns];

  if (index === -1) {
    turns.push(update(initialTurnState(turnId, "", "queued")));
  } else {
    turns[index] = update(turns[index]);
  }

  return { ...state, turns };
}

function withReceivedAt(event: LabRunEvent): LabRunEvent & {
  receivedAt: string;
} {
  return { ...event, receivedAt: new Date().toISOString() };
}

function defaultEnabledLanes(bootstrap: BootstrapStatus | null): Set<LaneId> {
  const lanes = new Set<LaneId>(["graphlit"]);

  if (!bootstrap) {
    DEFAULT_LANES.forEach((laneId) => lanes.add(laneId));
    return lanes;
  }

  for (const laneId of DEFAULT_LANES) {
    if (bootstrap.lanes[laneId]?.enabled) {
      lanes.add(laneId);
    }
  }

  return lanes;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)
  );
}

function createLinkedAbortController(
  parentSignal: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  clearStartupTimeout: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort(parentSignal.reason);
  const clearStartupTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    clearStartupTimeout,
    cleanup: () => {
      clearStartupTimeout();
      parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}

function nextLaneState(
  state: LaneUiState,
  event: LabRunEvent,
): LaneUiState {
  if (!("laneId" in event) || event.laneId !== state.id) {
    return state;
  }

  const turnId = "turnId" in event ? event.turnId : undefined;

  if (!turnId) {
    return state;
  }

  const recordedEvent = withReceivedAt(event);

  switch (event.type) {
    case "lane_started":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: "running",
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "lane_trace":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "lane_message_delta":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        answer: `${turn.answer}${event.text}`,
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "lane_message_snapshot":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        answer: event.text,
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "lane_reasoning_delta":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        reasoning: `${turn.reasoning}${event.text}`,
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "tool_call_started":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: "tool_calling",
        toolCalls: [
          ...turn.toolCalls.filter((call) => call.id !== event.call.id),
          event.call,
        ],
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "tool_call_completed":
    case "tool_call_failed":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: event.type === "tool_call_failed" ? "failed" : "running",
        toolCalls: turn.toolCalls.map((call) =>
          call.id === event.call.id ? event.call : call,
        ),
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    case "lane_completed":
      return updateLaneTurn(
        {
          ...state,
          session: { ...state.session, ...(event.result.session ?? {}) },
        },
        turnId,
        (turn) => ({
          ...turn,
          status: "completed",
          completedAt: event.result.completedAt ?? new Date().toISOString(),
          answer: event.result.finalAnswer || turn.answer,
          sources: event.result.sources,
          toolCalls: event.result.toolCalls,
          rawEvents: [
            ...turn.rawEvents,
            ...event.result.rawEvents,
            recordedEvent,
          ],
          result: event.result,
        }),
      );
    case "lane_failed":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: "failed",
        completedAt: turn.completedAt ?? new Date().toISOString(),
        error: event.error,
        rawEvents: [...turn.rawEvents, recordedEvent],
      }));
    default:
      return state;
  }
}

function statusTone(status: LaneStatus): string {
  switch (status) {
    case "completed":
      return "text-zinc-700 dark:text-zinc-300";
    case "failed":
      return "text-zinc-500";
    case "running":
    case "tool_calling":
      return "text-zinc-950 dark:text-zinc-100";
    default:
      return "text-zinc-500";
  }
}

function formatElapsedMs(ms: number): string {
  const secondsValue = Math.max(0, ms / 1000);
  const totalSeconds = Math.floor(secondsValue);

  if (totalSeconds < 60) {
    return `${secondsValue.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatTokenCount(value: number | null): string {
  return value === null ? "— TOK" : `${value.toLocaleString()} TOK`;
}

function formatTokenUsageTitle(usage?: TokenUsageTrace): string {
  if (!usage) {
    return "Turn weight unavailable: provider-reported model token usage was not returned.";
  }

  const inputText =
    usage.inputTokens === undefined
      ? "unknown input"
      : `${usage.inputTokens.toLocaleString()} input`;
  const outputText =
    usage.outputTokens === undefined
      ? "unknown output"
      : `${usage.outputTokens.toLocaleString()} output`;

  return `Turn weight: ${inputText} + ${outputText} = ${usage.totalTokens.toLocaleString()} total model tokens. Source: ${usage.source}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function turnTokenCount(turn: LaneTurnUiState): number | null {
  return turn.result?.tokenUsage?.totalTokens ?? null;
}

function turnElapsedMs(turn: LaneTurnUiState, nowMs: number): number {
  const startedAt = Date.parse(turn.startedAt);
  const endedAt = turn.completedAt ? Date.parse(turn.completedAt) : nowMs;

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return 0;
  }

  return Math.max(0, endedAt - startedAt);
}

function laneIconName(laneId: LaneId): Parameters<typeof BrandIcon>[0]["name"] {
  if (laneId === "graphlit") {
    return "graphlit";
  }

  if (laneId === "claude") {
    return "claude";
  }

  return laneId;
}

function providerIconName(
  provider: ModelProviderPreference,
): Parameters<typeof BrandIcon>[0]["name"] {
  if (provider === "anthropic") {
    return "claude";
  }

  return provider;
}

const answerMarkdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-2 text-[13px] leading-5 text-zinc-900 last:mb-0 dark:text-zinc-100">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 text-base font-semibold tracking-tight text-zinc-950 first:mt-0 dark:text-zinc-50">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-sm font-semibold tracking-tight text-zinc-950 first:mt-0 dark:text-zinc-50">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-[13px] font-semibold text-zinc-950 first:mt-0 dark:text-zinc-50">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-4 text-[13px] leading-5 text-zinc-900 last:mb-0 dark:text-zinc-100">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-4 text-[13px] leading-5 text-zinc-900 last:mb-0 dark:text-zinc-100">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ href, children }) => {
    const isExternal =
      href?.startsWith("http://") || href?.startsWith("https://");

    return (
      <a
        href={href}
        className="break-words font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-950 dark:text-zinc-50">
      {children}
    </strong>
  ),
  code: ({ className, children }) => {
    const isInline = className === undefined;

    if (isInline) {
      return (
        <code className="rounded-sm bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {children}
        </code>
      );
    }

    return <code className={className}>{children}</code>;
  },
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-sm border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs leading-5 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
      {children}
    </pre>
  ),
};

const sourceMarkdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-1 text-xs leading-5 text-zinc-600 last:mb-0 dark:text-zinc-400">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-1 text-xs font-semibold text-zinc-900 first:mt-0 dark:text-zinc-100">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1 text-xs font-semibold text-zinc-900 first:mt-0 dark:text-zinc-100">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 text-xs font-semibold text-zinc-900 first:mt-0 dark:text-zinc-100">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="mb-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-zinc-600 last:mb-0 dark:text-zinc-400">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-1 list-decimal space-y-0.5 pl-4 text-xs leading-5 text-zinc-600 last:mb-0 dark:text-zinc-400">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ href, children }) => {
    const isExternal =
      href?.startsWith("http://") || href?.startsWith("https://");

    return (
      <a
        href={href}
        className="break-words font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-zinc-300 pl-2 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-800 dark:text-zinc-200">
      {children}
    </strong>
  ),
  code: ({ className, children }) => {
    const isInline = className === undefined;

    if (isInline) {
      return (
        <code className="rounded-sm bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {children}
        </code>
      );
    }

    return <code className={className}>{children}</code>;
  },
  pre: ({ children }) => (
    <pre className="my-1 max-w-full overflow-x-auto rounded-sm border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </pre>
  ),
};

const jsonPrettyTheme = {
  main: "line-height:1.55;color:var(--trace-json-main);background:transparent;overflow:auto;font-family:var(--font-geist-mono),SFMono-Regular,Consolas,Liberation Mono,monospace;font-size:12px;",
  key: "color:var(--trace-json-key);font-weight:600;",
  string: "color:var(--trace-json-string);",
  value: "color:var(--trace-json-value);",
  boolean: "color:var(--trace-json-boolean);font-weight:600;",
  null: "color:var(--trace-json-null);font-style:italic;",
};

function markdownUrlTransform(url: string): string {
  if (url.startsWith("contents://")) {
    return url;
  }

  return defaultUrlTransform(url);
}

async function readRunStream(
  response: Response,
  onEvent: (event: LabRunEvent) => void,
) {
  if (!response.body) {
    throw new Error("Run response did not include a stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed) {
        onEvent(JSON.parse(trimmed) as LabRunEvent);
      }
    }
  }

  const trailing = buffer.trim();

  if (trailing) {
    onEvent(JSON.parse(trailing) as LabRunEvent);
  }
}

function fetchBootstrapStatus(): Promise<BootstrapFetchResult> {
  if (!bootstrapFetchPromise) {
    const startedAt = Date.now();

    console.info(
      "[agent-harness-lab/bootstrap] browser.start",
      JSON.stringify({
        url: "/api/bootstrap",
      }),
    );

    bootstrapFetchPromise = fetch("/api/bootstrap", {
      method: "POST",
    })
      .then(async (response) => {
        const text = await response.text();
        let body: BootstrapStatus | { error?: string };

        try {
          body = JSON.parse(text) as BootstrapStatus | { error?: string };
        } catch {
          body = {
            error: text.trim() || response.statusText,
          };
        }

        const result = {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          elapsedMs: Date.now() - startedAt,
          body,
        };

        console.info(
          "[agent-harness-lab/bootstrap] browser.response",
          JSON.stringify(result),
        );

        return result;
      })
      .catch((error) => {
        bootstrapFetchPromise = null;
        throw error;
      });
  }

  return bootstrapFetchPromise;
}

export function AppShell() {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [lanes, setLanes] = useState<Record<LaneId, LaneUiState>>(() =>
    Object.fromEntries(
      LANE_IDS.map((id) => [id, initialLaneState(id)]),
    ) as Record<LaneId, LaneUiState>,
  );
  const [enabledLanes, setEnabledLanes] = useState<Set<LaneId>>(
    () => new Set(DEFAULT_LANES),
  );
  const [runLaneIds, setRunLaneIds] = useState<Set<LaneId>>(
    () => new Set(DEFAULT_LANES),
  );
  const [prompt, setPrompt] = useState("");
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    DEFAULT_REASONING_EFFORT,
  );
  const [modelProvider, setModelProvider] = useState<ModelProviderPreference>(
    DEFAULT_MODEL_PROVIDER,
  );
  const [modelSize, setModelSize] = useState<ModelSize>(DEFAULT_MODEL_SIZE);
  const [systemPromptEnabled, setSystemPromptEnabled] = useState(
    DEFAULT_SYSTEM_PROMPT_ENABLED,
  );
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [judge, setJudge] = useState<JudgeUiState>({ status: "idle" });
  const [isRunning, setIsRunning] = useState(false);
  const [isComposerCollapsed, setIsComposerCollapsed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [colorTheme, setColorTheme] = useState<ColorTheme>("dark");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const runSequenceRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  function getSessionId(): string {
    if (!sessionIdRef.current) {
      sessionIdRef.current = createClientId("session");
    }

    return sessionIdRef.current;
  }

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("agent-harness-lab-theme");

    if (storedTheme === "light") {
      setColorTheme("light");
    }

    const storedHistory = window.localStorage.getItem(PROMPT_HISTORY_KEY);

    if (storedHistory) {
      try {
        const parsed = JSON.parse(storedHistory);

        if (Array.isArray(parsed)) {
          setPromptHistory(
            parsed
              .filter((item): item is string => typeof item === "string")
              .slice(0, MAX_PROMPT_HISTORY),
          );
        }
      } catch {
        window.localStorage.removeItem(PROMPT_HISTORY_KEY);
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    document.documentElement.classList.toggle("dark", colorTheme === "dark");
    document.documentElement.style.colorScheme = colorTheme;
    window.localStorage.setItem("agent-harness-lab-theme", colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    if (!isRunning) {
      setNowMs(Date.now());
      return;
    }

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);

    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapApp() {
      try {
        const result = await fetchBootstrapStatus();

        if (!cancelled) {
          if (!result.ok) {
            const message =
              "error" in result.body && result.body.error
                ? result.body.error
                : result.statusText;

            setBootstrapError(message);
            return;
          }

          const status = result.body as BootstrapStatus;
          setBootstrap(status);
          setReasoningEffort(status.defaultReasoningEffort);
          setModelProvider(status.defaultModelProvider);
          setModelSize(status.defaultModelSize);
          const nextEnabled = defaultEnabledLanes(status);
          setEnabledLanes(nextEnabled);
          setRunLaneIds(nextEnabled);
        }
      } catch (error) {
        console.error(
          "[agent-harness-lab/bootstrap] browser.failed",
          JSON.stringify({
            error: browserErrorDetails(error),
          }),
        );

        if (!cancelled) {
          setBootstrapError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    void bootstrapApp();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedLanes = useMemo(
    () => LANE_IDS.filter((laneId) => enabledLanes.has(laneId)),
    [enabledLanes],
  );

  const laneList = useMemo(
    () => LANE_IDS.map((laneId) => lanes[laneId]),
    [lanes],
  );
  const visibleLaneList = useMemo(
    () =>
      laneList.filter(
        (lane) => runLaneIds.has(lane.id) || laneHasTranscript(lane),
      ),
    [laneList, runLaneIds],
  );
  const hasLaneContent = laneList.some(laneHasTranscript);
  const isLight = colorTheme === "light";

  const canRun =
    prompt.trim().length > 0 &&
    !isRunning &&
    Boolean(bootstrap?.graphlit.ready) &&
    enabledLanes.has("graphlit");

  function rememberPrompt(value: string) {
    const trimmed = value.trim();

    if (!trimmed) {
      return;
    }

    setPromptHistory((current) => {
      const next = [
        trimmed,
        ...current.filter((item) => item !== trimmed),
      ].slice(0, MAX_PROMPT_HISTORY);

      window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));

      return next;
    });
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const isSubmitShortcut =
      (event.metaKey || event.ctrlKey) &&
      (event.key === "Enter" ||
        event.code === "Enter" ||
        event.code === "NumpadEnter");

    if (isSubmitShortcut) {
      event.preventDefault();
      void runComparison();
      return;
    }

    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }

    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      if (historyIndex !== -1) {
        setHistoryIndex(-1);
        setHistoryDraft("");
      }
      return;
    }

    if (!promptHistory.length || prompt.includes("\n")) {
      return;
    }

    const target = event.currentTarget;

    if (event.key === "ArrowUp" && target.selectionStart !== 0) {
      return;
    }

    if (
      event.key === "ArrowDown" &&
      target.selectionStart !== target.value.length
    ) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      const nextIndex = Math.min(historyIndex + 1, promptHistory.length - 1);

      if (historyIndex === -1) {
        setHistoryDraft(prompt);
      }

      setHistoryIndex(nextIndex);
      setPrompt(promptHistory[nextIndex] ?? "");
      return;
    }

    if (historyIndex === -1) {
      return;
    }

    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    setPrompt(nextIndex === -1 ? historyDraft : (promptHistory[nextIndex] ?? ""));
  }

  function applyEvent(event: LabRunEvent, runSequence: number) {
    if (runSequence !== runSequenceRef.current) {
      return;
    }

    if ("laneId" in event) {
      setLanes((current) => ({
        ...current,
        [event.laneId]: nextLaneState(current[event.laneId], event),
      }));
    }

    if (event.type === "judge_started") {
      setJudge({ status: "running", turnId: event.turnId });
    }

    if (event.type === "judge_completed") {
      setJudge({
        status: "completed",
        turnId: event.turnId,
        result: event.result,
      });
    }

    if (event.type === "judge_failed") {
      setJudge({ status: "failed", turnId: event.turnId, error: event.error });
    }

    // run_completed is emitted by each lane stream. runComparison owns the
    // aggregate running state once all selected lanes and judge finish.
  }

  async function runComparison() {
    const currentPrompt = prompt.trim();

    if (!currentPrompt || !bootstrap?.graphlit.ready) {
      return;
    }

    activeRunControllerRef.current?.abort();
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    const runSequence = runSequenceRef.current + 1;
    runSequenceRef.current = runSequence;
    const runId = createClientId("run");
    const turnId = createClientId("turn");
    const runtimeUtc = new Date().toISOString();
    const activeSessionId = getSessionId();
    const selectedLaneSet = new Set(selectedLanes);
    const priorVisibleLaneIds = LANE_IDS.filter((laneId) =>
      laneHasTranscript(lanes[laneId]),
    );
    const laneSessions = Object.fromEntries(
      selectedLanes.map((laneId) => [laneId, lanes[laneId].session]),
    );

    rememberPrompt(currentPrompt);
    setPrompt("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    setIsRunning(true);
    setIsComposerCollapsed(true);
    setRunLaneIds(new Set([...priorVisibleLaneIds, ...selectedLanes]));
    setJudge({ status: "idle", turnId });
    setLanes((current) =>
      Object.fromEntries(
        LANE_IDS.map((id) => {
          const lane = current[id];

          if (!selectedLaneSet.has(id)) {
            return [id, lane];
          }

          return [
            id,
            {
              ...lane,
              turns: [
                ...lane.turns,
                initialTurnState(turnId, currentPrompt, "queued"),
              ],
            },
          ];
        }),
      ) as Record<LaneId, LaneUiState>,
    );

    type LaneOutcome =
      | { status: "completed"; laneId: LaneId; result: LaneRunResult }
      | { status: "failed"; laneId: LaneId; error: string };

    const runLane = async (laneId: LaneId): Promise<LaneOutcome> => {
      let outcome: LaneOutcome | null = null;
      const laneRequest = createLinkedAbortController(
        controller.signal,
        LANE_START_TIMEOUT_MS,
      );

      try {
        const response = await fetch(`/api/lanes/${laneId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            sessionId: activeSessionId,
            turnId,
            prompt: currentPrompt,
            reasoningEffort,
            modelProvider,
            modelSize,
            systemPromptEnabled,
            runtimeUtc,
            laneSession: laneSessions[laneId],
          }),
          signal: laneRequest.signal,
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        await readRunStream(response, (event) => {
          laneRequest.clearStartupTimeout();
          applyEvent(event, runSequence);

          if (event.type === "lane_completed" && event.laneId === laneId) {
            outcome = {
              status: "completed",
              laneId,
              result: event.result,
            };
          }

          if (event.type === "lane_failed" && event.laneId === laneId) {
            outcome = {
              status: "failed",
              laneId,
              error: event.error,
            };
          }
        });

        return (
          outcome ?? {
            status: "failed",
            laneId,
            error: `${LANE_LABELS[laneId]} stream closed without a result.`,
          }
        );
      } catch (error) {
        if (isAbortError(error)) {
          if (laneRequest.timedOut()) {
            const message = `${LANE_LABELS[laneId]} request did not start streaming within ${Math.round(
              LANE_START_TIMEOUT_MS / 1000,
            )}s.`;

            applyEvent(
              {
                type: "lane_failed",
                runId,
                turnId,
                laneId,
                error: message,
              },
              runSequence,
            );

            return {
              status: "failed",
              laneId,
              error: message,
            };
          }

          return {
            status: "failed",
            laneId,
            error: "Lane request was aborted.",
          };
        }

        const message = error instanceof Error ? error.message : String(error);

        applyEvent(
          {
            type: "lane_failed",
            runId,
            turnId,
            laneId,
            error: message,
          },
          runSequence,
        );

        return { status: "failed", laneId, error: message };
      } finally {
        laneRequest.cleanup();
      }
    };

    try {
      const outcomes = await Promise.all(selectedLanes.map(runLane));

      if (runSequence !== runSequenceRef.current || controller.signal.aborted) {
        return;
      }

      const completed = outcomes
        .filter(
          (outcome): outcome is Extract<LaneOutcome, { status: "completed" }> =>
            outcome.status === "completed",
        )
        .map((outcome) => outcome.result);
      const failed = outcomes
        .filter(
          (outcome): outcome is Extract<LaneOutcome, { status: "failed" }> =>
            outcome.status === "failed",
        )
        .map((outcome) => ({
          laneId: outcome.laneId,
          error: outcome.error,
        }));

      if (judgeEnabled) {
        if (completed.length < 2) {
          setJudge({
            status: "failed",
            turnId,
            error: "Judge requires at least two completed lanes.",
          });
        } else {
          setJudge({ status: "running", turnId });

          const judgeRequest = createLinkedAbortController(
            controller.signal,
            JUDGE_CLIENT_TIMEOUT_MS,
          );

          try {
            const response = await fetch("/api/judge", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                runId,
                turnId,
                prompt: currentPrompt,
                results: completed,
                failed,
              }),
              signal: judgeRequest.signal,
            });
            const body = (await response.json()) as {
              result?: JudgeResult;
              error?: string;
            };

            if (!response.ok || !body.result) {
              throw new Error(body.error ?? "Judge failed.");
            }

            setJudge({
              status: "completed",
              turnId,
              result: body.result,
            });
          } catch (error) {
            if (isAbortError(error)) {
              if (judgeRequest.timedOut()) {
                setJudge({
                  status: "failed",
                  turnId,
                  error: "Judge request timed out before completing.",
                });

                return;
              }

              throw error;
            }

            setJudge({
              status: "failed",
              turnId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            judgeRequest.cleanup();
          }
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setLanes((current) =>
        Object.fromEntries(
          LANE_IDS.map((id) => {
            const lane = current[id];

            if (!selectedLaneSet.has(id)) {
              return [id, lane];
            }

            return [
              id,
              updateLaneTurn(lane, turnId, (turn) => ({
                ...turn,
                status: "failed",
                completedAt: turn.completedAt ?? new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
              })),
            ];
          }),
        ) as Record<LaneId, LaneUiState>,
      );
      setJudge({
        status: "failed",
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (runSequence === runSequenceRef.current) {
        setIsRunning(false);
        activeRunControllerRef.current = null;
      }
    }
  }

  function resetLab() {
    activeRunControllerRef.current?.abort();
    activeRunControllerRef.current = null;
    runSequenceRef.current += 1;
    sessionIdRef.current = createClientId("session");
    const nextEnabled = defaultEnabledLanes(bootstrap);

    setPrompt("");
    setHistoryIndex(-1);
    setHistoryDraft("");
    setReasoningEffort(
      bootstrap?.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
    );
    setModelProvider(bootstrap?.defaultModelProvider ?? DEFAULT_MODEL_PROVIDER);
    setModelSize(bootstrap?.defaultModelSize ?? DEFAULT_MODEL_SIZE);
    setSystemPromptEnabled(DEFAULT_SYSTEM_PROMPT_ENABLED);
    setJudgeEnabled(true);
    setJudge({ status: "idle" });
    setIsRunning(false);
    setIsComposerCollapsed(false);
    setEnabledLanes(nextEnabled);
    setRunLaneIds(nextEnabled);
    setLanes(
      Object.fromEntries(
        LANE_IDS.map((id) => [id, initialLaneState(id)]),
      ) as Record<LaneId, LaneUiState>,
    );
    promptRef.current?.focus();
  }

  function toggleLane(laneId: LaneId) {
    if (laneId === "graphlit" || isRunning) {
      return;
    }

    setEnabledLanes((current) => {
      const next = new Set(current);

      if (next.has(laneId)) {
        next.delete(laneId);
      } else {
        next.add(laneId);
      }

      return next;
    });
  }

  return (
    <main
      className="flex h-[100dvh] w-full flex-col overflow-x-hidden bg-zinc-50 text-zinc-900 transition-colors duration-200 dark:bg-[#09090b] dark:text-zinc-100"
    >
      <header
        className="flex w-full shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 py-4 transition-colors duration-200 dark:border-zinc-900 dark:bg-[#09090b]"
      >
        <div>
          <h1 className="text-md font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Graphlit Agent Harness Lab
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <IconTooltip label="Reset lab">
            <button
              type="button"
              aria-label="Reset lab"
              title="Reset lab"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-300 text-zinc-500 transition-all hover:bg-zinc-100 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-100"
              onClick={resetLab}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </IconTooltip>
          <IconTooltip label={`Switch to ${isLight ? "dark" : "light"} theme`}>
            <button
              type="button"
              aria-label={`Switch to ${isLight ? "dark" : "light"} theme`}
              title={`Switch to ${isLight ? "dark" : "light"} theme`}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-300 text-zinc-500 transition-all hover:bg-zinc-100 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-100"
              onClick={() => setColorTheme(isLight ? "dark" : "light")}
            >
              {isLight ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
            </button>
          </IconTooltip>
        </div>
      </header>

      <section
        className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-zinc-50 transition-colors duration-200 dark:bg-[#09090b]"
      >
        {!hasLaneContent ? (
          <div className="agent-harness-lanes-scroll flex min-h-0 w-full flex-1 flex-nowrap snap-x snap-mandatory overflow-x-auto md:snap-none">
            <div className="flex h-full w-full shrink-0 snap-center flex-col items-center justify-center border-r border-transparent px-6 pb-40 last:border-r-0 md:flex-1 md:shrink md:border-zinc-200 dark:md:border-zinc-800">
              <div className="text-center">
                <div
                  className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-xl border border-blue-200 bg-blue-50/80 shadow-lg transition-colors duration-200 dark:border-blue-900/80 dark:bg-blue-950/40"
                >
                  <BrandIcon
                    name="graphlit"
                    className="h-7 w-7"
                    alt="Graphlit"
                  />
                </div>
                <h1 className="text-2xl font-medium tracking-tight text-zinc-900 dark:text-zinc-50">
                  What do you want to compare?
                </h1>
                <p className="mt-2 text-base text-zinc-500">
                  Send prompts. Watch each agent harness use the same Graphlit tools.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="agent-harness-lanes-scroll flex min-h-0 w-full flex-1 flex-nowrap snap-x snap-mandatory overflow-x-auto md:snap-none">
              {visibleLaneList.map((lane) => (
                <LanePanel
                  key={lane.id}
                  lane={lane}
                  modelProvider={modelProvider}
                  modelSize={modelSize}
                  nowMs={nowMs}
                  enabled={enabledLanes.has(lane.id)}
                  disabledReason={bootstrap?.lanes[lane.id]?.reason}
                />
              ))}
            </div>
            <JudgePanel judge={judge} onClose={() => setJudge({ status: "idle" })} />
          </>
        )}
      </section>

      <Composer
        prompt={prompt}
        setPrompt={setPrompt}
        promptRef={promptRef}
        reasoningEffort={reasoningEffort}
        setReasoningEffort={setReasoningEffort}
        modelProvider={modelProvider}
        setModelProvider={setModelProvider}
        modelSize={modelSize}
        setModelSize={setModelSize}
        systemPromptEnabled={systemPromptEnabled}
        setSystemPromptEnabled={setSystemPromptEnabled}
        judgeEnabled={judgeEnabled}
        setJudgeEnabled={setJudgeEnabled}
        enabledLanes={enabledLanes}
        toggleLane={toggleLane}
        bootstrap={bootstrap}
        bootstrapError={bootstrapError}
        isRunning={isRunning}
        isCollapsed={isComposerCollapsed}
        setIsCollapsed={setIsComposerCollapsed}
        canCollapse={hasLaneContent}
        canRun={canRun}
        onPromptKeyDown={handlePromptKeyDown}
        onRun={runComparison}
      />
    </main>
  );
}

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="group relative flex">
      {children}
      <div className="pointer-events-none absolute right-0 top-full z-20 mt-2 whitespace-nowrap rounded-sm border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-600 opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        {label}
      </div>
    </div>
  );
}

function Composer({
  prompt,
  setPrompt,
  promptRef,
  reasoningEffort,
  setReasoningEffort,
  modelProvider,
  setModelProvider,
  modelSize,
  setModelSize,
  systemPromptEnabled,
  setSystemPromptEnabled,
  judgeEnabled,
  setJudgeEnabled,
  enabledLanes,
  toggleLane,
  bootstrap,
  bootstrapError,
  isRunning,
  isCollapsed,
  setIsCollapsed,
  canCollapse,
  canRun,
  onPromptKeyDown,
  onRun,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  modelProvider: ModelProviderPreference;
  setModelProvider: (value: ModelProviderPreference) => void;
  modelSize: ModelSize;
  setModelSize: (value: ModelSize) => void;
  systemPromptEnabled: boolean;
  setSystemPromptEnabled: (value: boolean) => void;
  judgeEnabled: boolean;
  setJudgeEnabled: (value: boolean) => void;
  enabledLanes: Set<LaneId>;
  toggleLane: (laneId: LaneId) => void;
  bootstrap: BootstrapStatus | null;
  bootstrapError: string | null;
  isRunning: boolean;
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
  canCollapse: boolean;
  canRun: boolean;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRun: () => void;
}) {
  const hasPrompt = prompt.trim().length > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ingestStatus, setIngestStatus] = useState<IngestUiStatus | null>(null);
  const [isUriFormOpen, setIsUriFormOpen] = useState(false);
  const [uriValue, setUriValue] = useState("");
  const isIngesting = ingestStatus?.state === "running";
  const graphlitIngestDisabled =
    isRunning || isIngesting || bootstrap?.graphlit.ready !== true;
  const graphlitIngestDisabledReason =
    bootstrap?.graphlit.error ?? "Checking Graphlit project...";
  const statusText = bootstrap?.graphlit.ready
    ? "Project initialized successfully."
    : (bootstrap?.graphlit.error ?? "Checking Graphlit project...");
  const telemetryText =
    [bootstrapError, bootstrap?.warning, ingestStatus?.message, statusText]
      .filter(Boolean)
      .join(" ") ||
    "Ready.";
  const footerStatusText = isRunning
    ? `Running ${enabledLanes.size.toLocaleString()} ${
        enabledLanes.size === 1 ? "lane" : "lanes"
      }...`
    : telemetryText;
  const enabledLaneText = `${enabledLanes.size.toLocaleString()} ${
    enabledLanes.size === 1 ? "lane" : "lanes"
  }`;
  const settingsSummary = [
    `${formatControlValue(reasoningEffort)} effort`,
    MODEL_PROVIDER_LABELS[modelProvider],
    getLaneModelLabel("graphlit", modelSize, modelProvider),
    systemPromptEnabled ? "Optimized system" : "Provider defaults",
    judgeEnabled ? "Judge on" : "Judge off",
    enabledLaneText,
  ].join(" · ");

  function openComposer() {
    setIsCollapsed(false);
    window.setTimeout(() => promptRef.current?.focus(), 0);
  }

  async function ingestUri(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const uri = uriValue.trim();

    if (!uri || graphlitIngestDisabled) {
      return;
    }

    setIngestStatus({
      state: "running",
      kind: "uri",
      message: "Ingesting URI into Graphlit...",
    });

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "uri", uri }),
      });
      const result = await readIngestApiResult(response);

      setIngestStatus({
        state: result.ready ? "ready" : "pending",
        kind: "uri",
        message: result.message,
      });
      setUriValue("");
      setIsUriFormOpen(false);
    } catch (error) {
      setIngestStatus({
        state: "error",
        kind: "uri",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ingestSelectedFile(file: File) {
    if (graphlitIngestDisabled) {
      return;
    }

    setIngestStatus({
      state: "running",
      kind: "file",
      message: `Ingesting ${file.name} into Graphlit...`,
    });

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/ingest", {
        method: "POST",
        body: formData,
      });
      const result = await readIngestApiResult(response);

      setIngestStatus({
        state: result.ready ? "ready" : "pending",
        kind: "file",
        message: result.message,
      });
    } catch (error) {
      setIngestStatus({
        state: "error",
        kind: "file",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setIsUriFormOpen(false);

    if (file) {
      void ingestSelectedFile(file);
    }
  }

  if (isCollapsed && canCollapse) {
    return (
      <footer className="flex h-16 shrink-0 items-center border-t border-zinc-200 bg-zinc-50 transition-colors duration-200 dark:border-zinc-900 dark:bg-[#09090b]">
        <button
          type="button"
          aria-label="Open chat composer"
          className="mx-auto flex h-full w-full max-w-6xl items-center justify-between gap-4 px-4 text-left transition-colors hover:bg-zinc-100/60 md:px-6 dark:hover:bg-zinc-900/40"
          onClick={openComposer}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] tracking-wider text-zinc-500">
              <span
                className={classNames(
                  "h-2 w-2 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-700",
                  isRunning && "animate-pulse",
                )}
              />
              <span className="truncate">{footerStatusText}</span>
            </div>
            <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              {settingsSummary}
            </div>
          </div>
          <span className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-700 shadow-sm transition-colors hover:text-zinc-950 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50">
            <ChevronUp className="h-4 w-4" />
            Open
          </span>
        </button>
      </footer>
    );
  }

  return (
    <footer className="flex shrink-0 flex-col justify-end border-t border-zinc-200 bg-zinc-50 pt-4 transition-colors duration-200 dark:border-zinc-900 dark:bg-[#09090b]">
      <div className="mx-auto flex w-full max-w-6xl shrink-0 flex-col px-4 pb-4 md:px-6 md:pb-6">
        <div className="hide-scrollbar mb-4 flex w-full snap-x snap-mandatory items-center justify-start gap-4 overflow-x-auto px-4 pb-2 text-zinc-400 md:justify-center md:gap-6">
          <Segmented
            label="Effort"
            values={["low", "medium", "high"]}
            selected={reasoningEffort}
            onSelect={(value) =>
              setReasoningEffort(value as ReasoningEffort)
            }
            disabled={isRunning}
          />
          <ProviderPreference
            selected={modelProvider}
            onSelect={setModelProvider}
            providers={bootstrap?.modelProviders}
            disabled={isRunning}
          />
          <Segmented
            label="Model"
            values={["large", "small"]}
            selected={modelSize}
            onSelect={(value) => setModelSize(value as ModelSize)}
            disabled={isRunning}
          />
          <SystemPromptSwitch
            enabled={systemPromptEnabled}
            disabled={isRunning}
            onToggle={() => setSystemPromptEnabled(!systemPromptEnabled)}
          />
          <div className="h-6 w-px shrink-0 snap-start bg-zinc-200 dark:bg-zinc-800" />
          <JudgeSwitch
            enabled={judgeEnabled}
            disabled={isRunning}
            onToggle={() => setJudgeEnabled(!judgeEnabled)}
          />
          {canCollapse ? (
            <IconTooltip label="Collapse composer">
              <button
                type="button"
                aria-label="Collapse composer"
                title="Collapse composer"
                className="flex h-8 w-8 shrink-0 snap-start items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                onClick={() => setIsCollapsed(true)}
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </IconTooltip>
          ) : null}
        </div>
        <div className="flex w-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/20">
          <div className="relative w-full flex flex-col">
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onPromptKeyDown}
              className="w-full min-h-[100px] appearance-none bg-transparent px-4 pt-4 pb-12 text-base text-zinc-900 outline-none dark:text-zinc-100 placeholder:text-zinc-500 border-none shadow-none focus:outline-none focus:ring-0 focus:shadow-none focus-visible:outline-none focus-visible:ring-0 resize-none"
              placeholder="Ask anything..."
              disabled={isRunning}
            />
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
              disabled={graphlitIngestDisabled}
            />
            <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <button
                  type="button"
                  aria-label="Add file"
                  title={
                    graphlitIngestDisabled
                      ? graphlitIngestDisabledReason
                      : "Add file"
                  }
                  className="flex items-center justify-center w-8 h-8 rounded-md text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    setIsUriFormOpen(false);
                    fileInputRef.current?.click();
                  }}
                  disabled={graphlitIngestDisabled}
                >
                  {isIngesting && ingestStatus?.kind === "file" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Paperclip className="w-4 h-4" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Add URI"
                  title={
                    graphlitIngestDisabled
                      ? graphlitIngestDisabledReason
                      : "Add URI"
                  }
                  className={classNames(
                    "flex items-center justify-center w-8 h-8 rounded-md text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
                    isUriFormOpen &&
                    "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
                  )}
                  onClick={() => setIsUriFormOpen((current) => !current)}
                  disabled={graphlitIngestDisabled}
                >
                  {isIngesting && ingestStatus?.kind === "uri" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Globe className="w-4 h-4" />
                  )}
                </button>
                {isUriFormOpen ? (
                  <>
                    <div className="mx-2 h-6 w-px shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={ingestUri}
                    >
                      <input
                        type="url"
                        value={uriValue}
                        onChange={(event) => setUriValue(event.target.value)}
                        className="h-8 min-w-0 max-w-md flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-500 focus:border-zinc-400 focus:ring-0 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-600"
                        placeholder="https://..."
                        disabled={isIngesting}
                        autoFocus
                      />
                      <button
                        type="submit"
                        className="flex h-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                        disabled={!uriValue.trim() || isIngesting}
                      >
                        Ingest
                      </button>
                    </form>
                  </>
                ) : null}
              </div>
              <button
                type="button"
                title="Send (Ctrl+Enter)"
                className={classNames(
                  "flex items-center justify-center gap-2 px-4 h-8 rounded-md text-sm font-medium transition-all duration-200 shrink-0",
                  hasPrompt
                    ? "opacity-100 cursor-pointer shadow-sm bg-zinc-900 text-white hover:bg-black dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    : "opacity-40 grayscale cursor-not-allowed shadow-none bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
                )}
                onClick={() => void onRun()}
                disabled={!canRun}
              >
                {isRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send
              </button>
            </div>
          </div>
          <div className="flex w-full items-center gap-3 overflow-hidden border-t border-zinc-200 bg-zinc-50/50 p-2 md:gap-4 md:p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
            <div className="flex shrink-0 items-center gap-4">
              {(() => {
                const laneId: LaneId = "graphlit";
                const readiness = bootstrap?.lanes[laneId];
                return (
                  <a
                    href="https://www.graphlit.dev/home"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Manage content in Graphlit"
                    className={classNames(
                      "flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#4752c4] bg-[#5865F2] px-3 text-xs font-semibold text-white shadow-sm ring-1 ring-inset ring-white/10 transition-all hover:border-[#7289da] hover:bg-[#4752c4] dark:border-[#7289da]",
                      isRunning && "opacity-80",
                    )}
                    title={
                      readiness?.reason
                        ? `${readiness.reason} Open Graphlit.`
                        : "Manage content in Graphlit"
                    }
                  >
                    <BrandIcon
                      name={laneIconName(laneId)}
                      className="h-3.5 w-3.5 opacity-100 grayscale-0"
                      alt={LANE_LABELS[laneId]}
                    />
                    {LANE_LABELS[laneId]}
                  </a>
                );
              })()}
              <div className="h-6 w-px rounded-full bg-zinc-300 dark:bg-zinc-700" />
            </div>
            <div className="hide-scrollbar flex flex-1 items-center justify-start gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
              {LANE_IDS.filter((laneId) => laneId !== "graphlit").map(
                (laneId) => {
                  const readiness = bootstrap?.lanes[laneId];
                  const disabled = isRunning || readiness?.enabled === false;
                  const isEnabled = enabledLanes.has(laneId);

                  return (
                    <button
                      key={laneId}
                      type="button"
                      className={classNames(
                        "agent-harness-lane-toggle group flex h-8 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-all disabled:cursor-not-allowed",
                        isEnabled
                          ? "border border-zinc-300 bg-zinc-100 text-zinc-900 shadow-sm dark:border-zinc-500 dark:bg-zinc-700 dark:text-zinc-50"
                          : "border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-200",
                        disabled && "opacity-45",
                      )}
                      onClick={() => toggleLane(laneId)}
                      disabled={disabled}
                      title={readiness?.reason}
                    >
                      <BrandIcon
                        name={laneIconName(laneId)}
                        className={classNames(
                          "h-3.5 w-3.5",
                          isEnabled
                            ? "opacity-100 grayscale-0"
                            : "opacity-60 grayscale transition-all group-hover:opacity-100 group-hover:grayscale-0",
                        )}
                        alt={LANE_LABELS[laneId]}
                      />
                      {LANE_LABELS[laneId]}
                    </button>
                  );
                },
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="flex w-full shrink-0 items-center justify-center gap-2 border-t border-zinc-200 bg-zinc-50 py-2 font-mono text-[11px] tracking-wider text-zinc-500 dark:border-zinc-900 dark:bg-[#09090b]">
        <span
          className={classNames(
            "h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-700",
            isRunning && "animate-pulse",
          )}
        />
        <span>{footerStatusText}</span>
      </div>
    </footer>
  );
}

function JudgeSwitch({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex shrink-0 snap-start items-center">
      <span className="mr-2 shrink-0 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        JUDGE
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? "Use optimized system prompt" : "Use provider defaults"}
        className={classNames(
          enabled
            ? "rounded-md border border-zinc-950 bg-zinc-900 px-3 py-1 text-xs font-semibold text-white dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50"
            : "rounded-md border border-zinc-200/80 bg-zinc-100/80 px-3 py-1 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:border-zinc-800/80 dark:bg-zinc-900/80 dark:text-zinc-400 dark:hover:text-zinc-200",
          disabled && "cursor-not-allowed opacity-60",
        )}
        onClick={onToggle}
        disabled={disabled}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

function SystemPromptSwitch({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [isPromptOpen, setIsPromptOpen] = useState(false);

  return (
    <div className="relative flex shrink-0 snap-start items-center">
      <span className="mr-2 shrink-0 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        System
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className={classNames(
          enabled
            ? "rounded-md border border-zinc-950 bg-zinc-900 px-3 py-1 text-xs font-semibold text-white dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50"
            : "rounded-md border border-zinc-200/80 bg-zinc-100/80 px-3 py-1 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:border-zinc-800/80 dark:bg-zinc-900/80 dark:text-zinc-400 dark:hover:text-zinc-200",
          disabled && "cursor-not-allowed opacity-60",
        )}
        onClick={onToggle}
        disabled={disabled}
      >
        {enabled ? "Optimized" : "Default"}
      </button>
      <button
        type="button"
        aria-label={
          enabled
            ? "Show optimized system prompt"
            : "Show provider default details"
        }
        aria-expanded={isPromptOpen}
        className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        onClick={() => setIsPromptOpen((current) => !current)}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {isPromptOpen ? (
        <div className="fixed bottom-36 left-4 right-4 z-50 mx-auto max-w-2xl">
          <div className="flex max-h-[min(28rem,calc(100vh-10rem))] flex-col rounded-md border border-zinc-200 bg-white p-3 text-left shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                {enabled ? "Optimized System Prompt" : "Provider Defaults"}
              </div>
              <button
                type="button"
                aria-label="Close system prompt"
                className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                onClick={() => setIsPromptOpen(false)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-sm bg-zinc-50 p-3 text-[11px] leading-5 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {enabled
                ? SYSTEM_PROMPT
                : "No optimized system prompt is sent. Each harness uses its provider or SDK defaults."}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProviderPreference({
  selected,
  onSelect,
  providers,
  disabled,
}: {
  selected: ModelProviderPreference;
  onSelect: (value: ModelProviderPreference) => void;
  providers?: BootstrapStatus["modelProviders"];
  disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 snap-start items-center">
      <span className="mr-2 shrink-0 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        Provider
      </span>
      <div className="flex items-center rounded-md border border-zinc-200/80 bg-zinc-100/80 p-0.5 dark:border-zinc-800/80 dark:bg-zinc-900/80">
        {MODEL_PROVIDER_PREFERENCES.map((provider) => {
          const active = selected === provider;
          const label = MODEL_PROVIDER_LABELS[provider];
          const readiness = providers?.[provider];
          const isUnavailable = readiness?.enabled === false;
          const isDisabled = disabled || isUnavailable;

          return (
            <button
              key={provider}
              type="button"
              aria-label={label}
              title={readiness?.reason ?? label}
              className={classNames(
                "flex items-center justify-center rounded-sm px-2.5 py-1 transition-colors",
                active
                  ? "border border-zinc-200 bg-white text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200",
                isDisabled && "cursor-not-allowed opacity-35 grayscale",
              )}
              onClick={() => onSelect(provider)}
              disabled={isDisabled}
            >
              <BrandIcon
                name={providerIconName(provider)}
                className={classNames(
                  "h-4 w-4",
                  active
                    ? "opacity-100 grayscale-0"
                    : "opacity-60 grayscale transition-all hover:opacity-100 hover:grayscale-0",
                )}
                alt={label}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Segmented({
  label,
  values,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  values: string[];
  selected: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 snap-start items-center">
      <span className="mr-2 shrink-0 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        {label}
      </span>
      <div className="flex items-center rounded-md border border-zinc-200/80 bg-zinc-100/80 p-0.5 dark:border-zinc-800/80 dark:bg-zinc-900/80">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            className={classNames(
              "whitespace-nowrap px-3 py-1 text-xs capitalize transition-colors",
              selected === value
                ? "rounded-sm border border-zinc-200 bg-white font-semibold text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
                : "font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
            onClick={() => onSelect(value)}
            disabled={disabled}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}

function LanePanel({
  lane,
  modelProvider,
  modelSize,
  nowMs,
  enabled,
  disabledReason,
}: {
  lane: LaneUiState;
  modelProvider: ModelProviderPreference;
  modelSize: ModelSize;
  nowMs: number;
  enabled: boolean;
  disabledReason?: string;
}) {
  const hasTranscript = laneHasTranscript(lane);

  return (
    <article className="flex h-full min-h-0 w-full shrink-0 snap-center flex-col border-r border-zinc-200 bg-white md:w-[25vw] md:min-w-[320px] md:max-w-[400px] md:snap-align-none md:[scroll-snap-align:none] dark:border-zinc-800 dark:bg-[#09090b]">
      <header className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
              <BrandIcon
                name={laneIconName(lane.id)}
                className="h-4 w-4"
                alt={LANE_LABELS[lane.id]}
              />
              {LANE_LABELS[lane.id]}
            </h2>
            <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0 truncate font-mono text-xs tabular-nums text-zinc-500">
                {getLaneModelLabel(lane.id, modelSize, modelProvider)}
              </div>
              <div
                className="shrink-0 rounded-sm border border-zinc-200 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-zinc-500 dark:border-zinc-800"
                title={LANE_STREAM_TITLES[lane.id]}
              >
                {LANE_STREAM_LABELS[lane.id]}
              </div>
            </div>
          </div>
        </div>
        {!enabled && disabledReason && !hasTranscript ? (
          <div className="mt-2 font-mono text-xs text-zinc-500">
            {disabledReason}
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasTranscript ? (
          lane.turns.map((turn, index) => (
            <LaneTurn
              key={turn.turnId}
              turn={turn}
              index={index}
              nowMs={nowMs}
            />
          ))
        ) : (
          <Section title="Answer">
            <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {enabled ? "Waiting for output." : "Disabled."}
            </div>
          </Section>
        )}
      </div>
    </article>
  );
}

function LaneTurn({
  turn,
  index,
  nowMs,
}: {
  turn: LaneTurnUiState;
  index: number;
  nowMs: number;
}) {
  const tokenCount = useMemo(() => turnTokenCount(turn), [turn]);
  const tokenUsage = turn.result?.tokenUsage;
  const eventStream = useMemo(() => turnEventStream(turn), [turn]);
  const eventMetrics = useMemo(
    () => turnEventSummary(turn, eventStream),
    [eventStream, turn],
  );

  return (
    <div className="border-b border-zinc-200/80 p-4 last:border-b-0 dark:border-zinc-800/50">
      <div className="mb-2 flex items-start justify-between border-b border-zinc-100 pb-2 dark:border-zinc-800">
        <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">
          Turn {index + 1}
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span
            className={classNames(
              "flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest tabular-nums text-zinc-500",
              statusTone(turn.status),
            )}
            title={turn.status.replace("_", " ")}
          >
            <Clock className="h-2.5 w-2.5" />
            {formatElapsedMs(turnElapsedMs(turn, nowMs))}
          </span>
          <span
            className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest tabular-nums text-zinc-400 dark:text-zinc-600"
            title={formatTokenUsageTitle(tokenUsage)}
          >
            <Hash className="h-2.5 w-2.5" />
            {formatTokenCount(tokenCount)}
          </span>
        </div>
      </div>
      <Section title="Prompt">
        <div className="whitespace-pre-wrap rounded-sm border border-zinc-200 bg-zinc-50 p-2 text-[13px] leading-5 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200">
          {turn.prompt}
        </div>
      </Section>
      <Section
        title="Answer"
        action={
          turn.answer ? <CopyMarkdownButton value={turn.answer} /> : undefined
        }
      >
        {turn.error ? (
          <div className="rounded-sm border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs tabular-nums text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            {turn.error}
          </div>
        ) : turn.answer ? (
          <MarkdownAnswer value={turn.answer} />
        ) : (
          <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            Waiting for output.
          </div>
        )}
      </Section>
      {turn.reasoning ? (
        <Section title="Thinking">
          <details className="rounded-sm border border-zinc-200 dark:border-zinc-800">
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">
              Reasoning trace
            </summary>
            <pre className="border-t border-zinc-200 p-2 font-mono text-xs tabular-nums text-zinc-500 dark:border-zinc-800">
              {turn.reasoning}
            </pre>
          </details>
        </Section>
      ) : null}
      <Section title="Tool Calls">
        <ToolTimeline calls={turn.toolCalls} />
      </Section>
      <Section title="Sources">
        <SourceList sources={turn.sources} />
      </Section>
      <section className="border-b border-zinc-200/80 p-4 dark:border-zinc-800/50">
        <EventSummary metrics={eventMetrics} />
        <EventStreamDetails events={eventStream} />
      </section>
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-zinc-200/80 p-4 dark:border-zinc-800/50">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
          {title}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CopyMarkdownButton({ value }: { value: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const label =
    copyState === "copied"
      ? "Copied markdown"
      : copyState === "failed"
        ? "Could not copy markdown"
        : "Copy markdown";

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    window.setTimeout(() => setCopyState("idle"), 1_200);
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={classNames(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-zinc-200 text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-100",
        copyState === "copied" && "text-emerald-600 dark:text-emerald-400",
        copyState === "failed" && "text-zinc-700 dark:text-zinc-200",
      )}
      onClick={() => void copyMarkdown()}
    >
      {copyState === "copied" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function MarkdownAnswer({ value }: { value: string }) {
  return (
    <div className="max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={answerMarkdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

type EventMetric = {
  label: string;
  value: string;
  title?: string;
};

function eventName(event: unknown): string {
  if (!isRecord(event)) {
    return "";
  }

  if (typeof event.type === "string") {
    return event.type;
  }

  if (typeof event.phase === "string") {
    return event.phase;
  }

  return isRecord(event.event) ? eventName(event.event) : "";
}

function eventTimestampMs(event: unknown, turnStartedAt: string): number | null {
  if (!isRecord(event)) {
    return null;
  }

  if (typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)) {
    const startedAt = Date.parse(turnStartedAt);

    return Number.isFinite(startedAt) ? startedAt + event.elapsedMs : null;
  }

  for (const key of ["timestamp", "receivedAt", "completedAt", "startedAt"]) {
    const value = event[key];

    if (typeof value === "string") {
      const parsed = Date.parse(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return isRecord(event.event)
    ? eventTimestampMs(event.event, turnStartedAt)
    : null;
}

function eventElapsedFromTurn(
  event: unknown,
  turnStartedAt: string,
): number | null {
  const startedAt = Date.parse(turnStartedAt);
  const eventAt = eventTimestampMs(event, turnStartedAt);

  if (!Number.isFinite(startedAt) || eventAt === null) {
    return null;
  }

  return Math.max(0, eventAt - startedAt);
}

function isDisplayHiddenEvent(event: unknown): boolean {
  return isRecord(event) && event.type === "tool_update";
}

function isAnswerEvent(event: unknown): boolean {
  if (!isRecord(event)) {
    return false;
  }

  if (
    (event.type === "lane_message_delta" ||
      event.type === "lane_message_snapshot") &&
    typeof event.text === "string" &&
    event.text.length > 0
  ) {
    return true;
  }

  if (event.type !== "message_update" || !isRecord(event.message)) {
    return false;
  }

  return (
    event.message.isThinking !== true &&
    typeof event.message.message === "string" &&
    event.message.message.length > 0
  );
}

function isThinkingEvent(event: unknown): boolean {
  if (!isRecord(event)) {
    return false;
  }

  if (
    event.type === "lane_reasoning_delta" &&
    typeof event.text === "string" &&
    event.text.length > 0
  ) {
    return true;
  }

  return (
    event.type === "message_update" &&
    isRecord(event.message) &&
    event.message.isThinking === true
  );
}

function firstElapsed(
  events: unknown[],
  turnStartedAt: string,
  predicate: (event: unknown) => boolean,
): number | null {
  let value: number | null = null;

  for (const event of events) {
    if (!predicate(event)) {
      continue;
    }

    const elapsed = eventElapsedFromTurn(event, turnStartedAt);

    if (elapsed === null) {
      continue;
    }

    value = value === null ? elapsed : Math.min(value, elapsed);
  }

  return value;
}

function elapsedLabel(value: number | null): string {
  return value === null ? "—" : formatElapsedMs(value);
}

function thinkingSummaryValue(
  turn: LaneTurnUiState,
  thinkingStart: number | null,
): string {
  if (turn.reasoning || thinkingStart !== null) {
    return thinkingStart === null ? "captured" : `from ${formatElapsedMs(thinkingStart)}`;
  }

  if (
    turn.status === "queued" ||
    turn.status === "running" ||
    turn.status === "tool_calling"
  ) {
    return "pending";
  }

  const effort = turn.result?.effectiveReasoningEffort;

  return effort ? `${effort} hidden` : "not exposed";
}

function turnEventSource(turn: LaneTurnUiState): unknown[] {
  const resultEvents = turn.result?.rawEvents;

  if (Array.isArray(resultEvents) && resultEvents.length > 0) {
    return resultEvents;
  }

  return turn.rawEvents;
}

function turnEventStream(turn: LaneTurnUiState): unknown[] {
  return turnEventSource(turn).filter((event) => !isDisplayHiddenEvent(event));
}

function turnEventSummary(
  turn: LaneTurnUiState,
  displayEvents: unknown[],
): EventMetric[] {
  const allEvents = [...turn.rawEvents, ...turnEventSource(turn)];
  const firstEvent = firstElapsed(
    allEvents,
    turn.startedAt,
    (event) =>
      !["lane_started", "lane_telemetry", "run_started"].includes(
        eventName(event),
      ),
  );
  const firstAnswer = firstElapsed(allEvents, turn.startedAt, isAnswerEvent);
  const firstTool =
    turn.toolCalls
      .map((call) => Date.parse(call.startedAt) - Date.parse(turn.startedAt))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right)[0] ?? null;
  const toolDuration = turn.toolCalls.reduce(
    (total, call) => total + (call.durationMs ?? 0),
    0,
  );
  const thinkingStart = firstElapsed(allEvents, turn.startedAt, isThinkingEvent);
  const thinkingValue = thinkingSummaryValue(turn, thinkingStart);

  return [
    {
      label: "First Event",
      value: elapsedLabel(firstEvent),
      title: "First non-start trace event received for this lane.",
    },
    {
      label: "First Tool",
      value: elapsedLabel(firstTool),
      title: "When the first normalized Graphlit tool call started.",
    },
    {
      label: "First Answer",
      value: elapsedLabel(firstAnswer),
      title: "First answer text delta or snapshot received by the UI.",
    },
    {
      label: "Tool Time",
      value: turn.toolCalls.length
        ? `${formatElapsedMs(toolDuration)} / ${turn.toolCalls.length}`
        : "none",
      title: "Total normalized tool duration across completed tool calls.",
    },
    {
      label: "Thinking",
      value: thinkingValue,
      title: "Reasoning trace timing when exposed. Some providers use reasoning internally without returning a thinking stream.",
    },
    {
      label: "Events",
      value: displayEvents.length.toLocaleString(),
      title: "Displayed event count after filtering noisy raw tool updates.",
    },
  ];
}

function EventSummary({ metrics }: { metrics: EventMetric[] }) {
  return (
    <div className="mb-2 grid grid-cols-2 gap-1.5">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          title={metric.title}
          className="rounded-sm border border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/50"
        >
          <div className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">
            {metric.label}
          </div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-800 dark:text-zinc-200">
            {metric.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  return (
    <JSONPretty
      data={value ?? null}
      theme={jsonPrettyTheme}
      className="agent-harness-json"
    />
  );
}

function EventStreamDetails({ events }: { events: unknown[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const eventLabel = `${events.length.toLocaleString()} ${
    events.length === 1 ? "event" : "events"
  }`;
  const copyLabel =
    copyState === "copied"
      ? "Copied events"
      : copyState === "failed"
        ? "Could not copy events"
        : "Copy events";

  async function copyEvents() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    window.setTimeout(() => setCopyState("idle"), 1_200);
  }

  return (
    <div className="rounded-sm border border-zinc-200 dark:border-zinc-800">
      <div
        className={classNames(
          "flex items-center justify-between gap-2",
          isOpen && "border-b border-zinc-200 dark:border-zinc-800",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-900/50"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          )}
          <span className="truncate">View {eventLabel}</span>
        </button>
        <button
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          className={classNames(
            "mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
            copyState === "copied" && "text-emerald-600 dark:text-emerald-400",
            copyState === "failed" && "text-zinc-700 dark:text-zinc-200",
          )}
          onClick={(event) => {
            event.stopPropagation();
            void copyEvents();
          }}
        >
          {copyState === "copied" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {isOpen ? (
        <div className="max-h-64 overflow-auto p-2">
          <JsonView value={events} />
        </div>
      ) : null}
    </div>
  );
}

function ToolTimeline({ calls }: { calls: ToolCallTrace[] }) {
  if (!calls.length) {
    return <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">No tool calls.</div>;
  }

  return (
    <div className="space-y-2">
      {calls.map((call) => (
        <details
          key={call.id}
          className="rounded-sm border border-zinc-200 dark:border-zinc-800"
        >
          <summary className="grid cursor-pointer grid-cols-[1fr_auto] gap-2 px-2 py-1.5">
            <span className="truncate font-mono text-xs tabular-nums text-zinc-900 dark:text-zinc-100">
              {call.name}
            </span>
            <span
              className={classNames(
                "font-mono text-xs uppercase tracking-widest",
                call.status === "failed"
                  ? "text-zinc-500"
                  : call.status === "completed"
                    ? "text-zinc-700 dark:text-zinc-300"
                    : "text-zinc-500",
              )}
            >
              {call.durationMs ? `${call.durationMs}ms` : call.status}
            </span>
          </summary>
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            <JsonBlock title="Arguments" value={call.arguments} />
            <JsonBlock
              title={call.error ? "Error" : "Result"}
              value={call.error ?? call.output}
              copyable
            />
          </div>
        </details>
      ))}
    </div>
  );
}

function SourceList({ sources }: { sources: SourceTrace[] }) {
  if (!sources.length) {
    return <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">No sources.</div>;
  }

  return (
    <div className="divide-y divide-zinc-200 rounded-sm border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {sources.map((source) => (
        <div key={source.resourceUri} className="p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                {source.name ?? "Untitled content"}
              </div>
              <div className="mt-1 truncate font-mono text-xs text-zinc-500">
                {source.resourceUri}
              </div>
            </div>
            <span className="font-mono text-xs tabular-nums text-zinc-500">
              {source.relevance == null ? "--" : source.relevance.toFixed(2)}
            </span>
          </div>
          {source.text ? (
            <div className="mt-2 max-h-20 overflow-hidden break-words">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={sourceMarkdownComponents}
                urlTransform={markdownUrlTransform}
              >
                {source.text}
              </ReactMarkdown>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function JsonBlock({
  title,
  value,
  copyable = false,
}: {
  title: string;
  value: unknown;
  copyable?: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const displayValue = typeof value === "string" ? { value } : value;
  const copyLabel =
    copyState === "copied"
      ? `Copied ${title.toLowerCase()} JSON`
      : copyState === "failed"
        ? `Could not copy ${title.toLowerCase()} JSON`
        : `Copy ${title.toLowerCase()} JSON`;

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(displayValue, null, 2) ?? "null",
      );
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    window.setTimeout(() => setCopyState("idle"), 1_200);
  }

  return (
    <div className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
        <div className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
          {title}
        </div>
        {copyable ? (
          <button
            type="button"
            aria-label={copyLabel}
            title={copyLabel}
            className={classNames(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
              copyState === "copied" &&
                "text-emerald-600 dark:text-emerald-400",
              copyState === "failed" && "text-zinc-700 dark:text-zinc-200",
            )}
            onClick={() => void copyJson()}
          >
            {copyState === "copied" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
      </div>
      <div className="max-h-64 overflow-auto p-2">
        <JsonView value={displayValue} />
      </div>
    </div>
  );
}

function sortedJudgeLanes(result: JudgeResult): JudgeResult["lanes"] {
  const graphlit = result.lanes.find((lane) => lane.laneId === "graphlit");
  const remaining = result.lanes
    .filter((lane) => lane.laneId !== "graphlit")
    .sort((left, right) => right.overallScore - left.overallScore);

  return graphlit ? [graphlit, ...remaining] : remaining;
}

function JudgePanel({
  judge,
  onClose,
}: {
  judge: JudgeUiState;
  onClose: () => void;
}) {
  if (judge.status === "idle") {
    return null;
  }

  const judgeLanes = judge.result ? sortedJudgeLanes(judge.result) : [];

  return (
    <aside className="flex max-h-64 shrink-0 flex-col border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#09090b]">
      <div className="shrink-0 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Judge
            </div>
            <div className="mt-1 text-sm font-semibold">
              {judge.status === "completed"
                ? judge.result?.winnerLaneId
                  ? `Winner: ${LANE_LABELS[judge.result.winnerLaneId]}`
                  : "No clear winner"
                : judge.status === "running"
                  ? "Scoring responses"
                  : "Scoring failed"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-xs tabular-nums text-zinc-500">
              {judge.status}
            </div>
            {judge.status === "running" ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-[#5865F2]"
                aria-hidden="true"
              />
            ) : null}
            {judge.status === "completed" || judge.status === "failed" ? (
              <button
                type="button"
                aria-label="Close judge panel"
                title="Close judge panel"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {judge.error ? (
          <div className="p-3 font-mono text-xs tabular-nums text-zinc-500">
            {judge.error}
          </div>
        ) : null}
        {judge.result ? (
          <div className="grid gap-0 md:grid-cols-[560px_1fr]">
            <div className="border-b border-zinc-200 p-3 md:border-b-0 md:border-r dark:border-zinc-800">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                Summary
              </div>
              <p className="text-sm leading-6 text-zinc-800 dark:text-zinc-200">
                {judge.result.summary}
              </p>
              <div className="mt-3 mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                Winner Rationale
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {judge.result.winnerReason}
              </p>
            </div>
            <div>
              {judgeLanes.map((lane) => {
                const isGraphlit = lane.laneId === "graphlit";

                return (
                  <div
                    key={lane.anonymousId}
                    className={classNames(
                      "grid gap-3 md:grid-cols-[120px_1fr]",
                      isGraphlit
                        ? "border-l-2 border-[#5865F2] bg-[#5865F2]/5 p-3 dark:bg-[#5865F2]/10"
                        : "border-t border-zinc-100 p-3 dark:border-zinc-800",
                    )}
                  >
                    <div>
                      <div
                        className={classNames(
                          "text-xs font-semibold",
                          isGraphlit && "text-[#5865F2]",
                        )}
                      >
                        {lane.laneId
                          ? LANE_LABELS[lane.laneId]
                          : lane.anonymousId}
                      </div>
                      <div className="mt-1 font-mono text-xs tabular-nums text-zinc-500">
                        {lane.overallScore}/10
                      </div>
                    </div>
                    <div>
                      <Gauge
                        value={lane.overallScore}
                        tone={isGraphlit ? "graphlit" : "neutral"}
                      />
                      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs text-zinc-500">
                        <span>retrieval {lane.retrievalUse}/10</span>
                        <span>inspect {lane.sourceInspection}/10</span>
                        <span>grounded {lane.groundedness}/10</span>
                        <span>helpful {lane.answerHelpfulness}/10</span>
                        <span>risk {lane.unsupportedClaimRisk}/10</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      {judge.result ? (
        <div className="shrink-0 border-t border-zinc-200 bg-white px-3 py-2 text-[11px] leading-4 text-zinc-500 dark:border-zinc-800 dark:bg-[#09090b] dark:text-zinc-400">
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            Retrieval
          </span>{" "}
          sources retrieved
          <span className="mx-2 text-zinc-300 dark:text-zinc-700">/</span>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            Grounded
          </span>{" "}
          claims supported
          <span className="mx-2 text-zinc-300 dark:text-zinc-700">/</span>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            Inspect
          </span>{" "}
          source details opened
          <span className="mx-2 text-zinc-300 dark:text-zinc-700">/</span>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            Helpful
          </span>{" "}
          complete and useful answer
          <span className="mx-2 text-zinc-300 dark:text-zinc-700">/</span>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
            Risk
          </span>{" "}
          unsupported-claim risk, lower is better
        </div>
      ) : null}
    </aside>
  );
}

function Gauge({
  value,
  tone = "neutral",
}: {
  value: number;
  tone?: "graphlit" | "neutral";
}) {
  return (
    <div className="grid grid-cols-10 gap-1">
      {Array.from({ length: 10 }).map((_, index) => (
        <div
          key={index}
          className={classNames(
            "h-1.5 rounded-sm border border-zinc-300 dark:border-zinc-700",
            index < value
              ? tone === "graphlit"
                ? "bg-[#5865F2]"
                : "bg-zinc-800 dark:bg-zinc-200"
              : "bg-zinc-100 dark:bg-zinc-900",
          )}
        />
      ))}
    </div>
  );
}
