"use client";

import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Moon,
  RotateCcw,
  Send,
  Sun,
} from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import JSONPretty from "react-json-pretty";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { BrandIcon } from "@/components/BrandIcon";
import {
  DEFAULT_LANES,
  DEFAULT_MODEL_SIZE,
  DEFAULT_REASONING_EFFORT,
  LANE_LABELS,
  LANE_MODEL_LABELS,
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
  type ModelSize,
  type ReasoningEffort,
  type SourceTrace,
  type ToolCallTrace,
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

let bootstrapFetchPromise: Promise<BootstrapFetchResult> | null = null;

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
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

function defaultEnabledLanes(bootstrap: BootstrapStatus | null): Set<LaneId> {
  const lanes = new Set<LaneId>(["graphlit"]);

  if (!bootstrap) {
    DEFAULT_LANES.forEach((laneId) => lanes.add(laneId));
    return lanes;
  }

  for (const laneId of DEFAULT_LANES) {
    if (laneId === "graphlit" || bootstrap.lanes[laneId]?.enabled) {
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

  switch (event.type) {
    case "lane_started":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: "running",
        rawEvents: [...turn.rawEvents, event],
      }));
    case "lane_trace":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        rawEvents: [...turn.rawEvents, event],
      }));
    case "lane_message_delta":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        answer: `${turn.answer}${event.text}`,
        rawEvents: [...turn.rawEvents, event],
      }));
    case "lane_message_snapshot":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        answer: event.text,
        rawEvents: [...turn.rawEvents, event],
      }));
    case "lane_reasoning_delta":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        reasoning: `${turn.reasoning}${event.text}`,
        rawEvents: [...turn.rawEvents, event],
      }));
    case "tool_call_started":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: "tool_calling",
        toolCalls: [
          ...turn.toolCalls.filter((call) => call.id !== event.call.id),
          event.call,
        ],
        rawEvents: [...turn.rawEvents, event],
      }));
    case "tool_call_completed":
    case "tool_call_failed":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: event.type === "tool_call_failed" ? "failed" : "running",
        toolCalls: turn.toolCalls.map((call) =>
          call.id === event.call.id ? event.call : call,
        ),
        rawEvents: [...turn.rawEvents, event],
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
          rawEvents: [...turn.rawEvents, ...event.result.rawEvents, event],
          result: event.result,
        }),
      );
    case "lane_failed":
      return updateLaneTurn(state, turnId, (turn) => ({
        ...turn,
        status: "failed",
        completedAt: turn.completedAt ?? new Date().toISOString(),
        error: event.error,
        rawEvents: [...turn.rawEvents, event],
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
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function turnElapsedMs(turn: LaneTurnUiState, nowMs: number): number {
  const startedAt = Date.parse(turn.startedAt);
  const endedAt = turn.completedAt ? Date.parse(turn.completedAt) : nowMs;

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return 0;
  }

  return Math.max(0, endedAt - startedAt);
}

function turnStatusText(turn: LaneTurnUiState, nowMs: number): string {
  return `${turn.status.replace("_", " ")} ${formatElapsedMs(
    turnElapsedMs(turn, nowMs),
  )}`;
}

function StatusIcon({ status }: { status: LaneStatus }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-3 w-3" />;
  }

  if (status === "failed") {
    return <CircleAlert className="h-3 w-3" />;
  }

  if (status === "running" || status === "tool_calling") {
    return <Loader2 className="h-3 w-3 animate-spin" />;
  }

  return <Activity className="h-3 w-3" />;
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
  const [modelSize, setModelSize] = useState<ModelSize>(DEFAULT_MODEL_SIZE);
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [judge, setJudge] = useState<JudgeUiState>({ status: "idle" });
  const [isRunning, setIsRunning] = useState(false);
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
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
            modelSize,
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
    setModelSize(bootstrap?.defaultModelSize ?? DEFAULT_MODEL_SIZE);
    setJudgeEnabled(true);
    setJudge({ status: "idle" });
    setIsRunning(false);
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
      className="flex h-screen min-h-screen flex-col justify-between bg-zinc-50 text-zinc-900 transition-colors duration-200 dark:bg-[#09090b] dark:text-zinc-100"
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
        className="flex min-h-0 flex-1 overflow-hidden bg-zinc-50 transition-colors duration-200 dark:bg-[#09090b]"
      >
        {laneList.every((lane) => !laneHasTranscript(lane)) ? (
          <div className="flex h-full flex-1 items-center justify-center px-6 pb-40">
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
                Ask once. Watch each agent harness use the same Graphlit tools.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-x-auto">
              <div
                className={classNames(
                  "flex h-full",
                  visibleLaneList.length > 3 ? "min-w-[1120px]" : "min-w-full",
                )}
              >
                {visibleLaneList.map((lane) => (
                  <LanePanel
                    key={lane.id}
                    lane={lane}
                    modelSize={modelSize}
                    nowMs={nowMs}
                    enabled={enabledLanes.has(lane.id)}
                    disabledReason={bootstrap?.lanes[lane.id]?.reason}
                  />
                ))}
              </div>
            </div>
            <JudgePanel judge={judge} />
          </div>
        )}
      </section>

      <Composer
        prompt={prompt}
        setPrompt={setPrompt}
        promptRef={promptRef}
        reasoningEffort={reasoningEffort}
        setReasoningEffort={setReasoningEffort}
        modelSize={modelSize}
        setModelSize={setModelSize}
        judgeEnabled={judgeEnabled}
        setJudgeEnabled={setJudgeEnabled}
        enabledLanes={enabledLanes}
        toggleLane={toggleLane}
        bootstrap={bootstrap}
        bootstrapError={bootstrapError}
        isRunning={isRunning}
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
  modelSize,
  setModelSize,
  judgeEnabled,
  setJudgeEnabled,
  enabledLanes,
  toggleLane,
  bootstrap,
  bootstrapError,
  isRunning,
  canRun,
  onPromptKeyDown,
  onRun,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  promptRef: RefObject<HTMLTextAreaElement>;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  modelSize: ModelSize;
  setModelSize: (value: ModelSize) => void;
  judgeEnabled: boolean;
  setJudgeEnabled: (value: boolean) => void;
  enabledLanes: Set<LaneId>;
  toggleLane: (laneId: LaneId) => void;
  bootstrap: BootstrapStatus | null;
  bootstrapError: string | null;
  isRunning: boolean;
  canRun: boolean;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRun: () => void;
}) {
  const statusText = bootstrap?.graphlit.ready
    ? "Project bound successfully."
    : (bootstrap?.graphlit.error ?? "Checking Graphlit project...");
  const telemetryText =
    [bootstrapError, bootstrap?.warning, statusText].filter(Boolean).join(" ") ||
    "Ready.";

  return (
    <footer className="shrink-0 border-t border-zinc-200 bg-zinc-50 pt-4 transition-colors duration-200 dark:border-zinc-900 dark:bg-[#09090b]">
      <div className="scrollbar-none mx-auto mb-3 flex w-full max-w-4xl items-center gap-6 overflow-x-auto px-4 text-xs text-zinc-500 dark:text-zinc-400">
        <Segmented
          label="Effort"
          values={["low", "medium", "high"]}
          selected={reasoningEffort}
          onSelect={(value) => setReasoningEffort(value as ReasoningEffort)}
          disabled={isRunning}
        />
        <Segmented
          label="Model"
          values={["large", "small"]}
          selected={modelSize}
          onSelect={(value) => setModelSize(value as ModelSize)}
          disabled={isRunning}
        />
        <JudgeSwitch
          enabled={judgeEnabled}
          disabled={isRunning}
          onToggle={() => setJudgeEnabled(!judgeEnabled)}
        />
      </div>
      <div className="mx-auto w-full max-w-4xl shrink-0 px-4 pb-6">
        <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm transition-colors duration-200 focus-within:border-zinc-400 focus-within:ring-1 focus-within:ring-zinc-400/40 dark:border-zinc-800 dark:bg-zinc-900/20 dark:shadow-none dark:focus-within:border-zinc-700 dark:focus-within:ring-zinc-700/50">
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onPromptKeyDown}
            className="min-h-[110px] w-full resize-none border-none bg-transparent p-4 font-sans text-base text-zinc-900 placeholder:text-zinc-400 focus:ring-0 dark:text-zinc-100 dark:placeholder:text-zinc-600"
            placeholder="Ask anything..."
            disabled={isRunning}
          />
          <div className="border-t border-zinc-100 dark:border-zinc-900/80" />
          <div className="flex items-center justify-between gap-4 bg-zinc-50/50 p-3 transition-colors duration-200 dark:bg-zinc-950/40">
            <div className="scrollbar-none flex items-center gap-2 overflow-x-auto whitespace-nowrap">
              {LANE_IDS.map((laneId) => {
                const readiness = bootstrap?.lanes[laneId];
                const disabled =
                  laneId === "graphlit" ||
                  isRunning ||
                  readiness?.enabled === false;
                const isGraphlit = laneId === "graphlit";
                const isEnabled = enabledLanes.has(laneId);

                return (
                  <Fragment key={laneId}>
                    <button
                      type="button"
                      className={classNames(
                        "group flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition-all duration-150",
                        isGraphlit
                          ? "border border-blue-200 bg-blue-50/80 font-semibold text-blue-700 dark:border-blue-900/80 dark:bg-blue-950/40 dark:text-blue-400"
                          : isEnabled
                            ? "border border-zinc-300 bg-zinc-100 font-semibold text-zinc-900 shadow-sm dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50"
                            : "border border-zinc-200 bg-white font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800/80 dark:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-200",
                        disabled && !isGraphlit && "opacity-45",
                      )}
                      onClick={() => toggleLane(laneId)}
                      disabled={disabled}
                      title={readiness?.reason}
                    >
                      <BrandIcon
                        name={laneIconName(laneId)}
                        className={classNames(
                          "h-4 w-4",
                          isEnabled
                            ? "opacity-100 grayscale-0"
                            : "opacity-60 grayscale transition-all group-hover:opacity-100 group-hover:grayscale-0",
                        )}
                        alt={LANE_LABELS[laneId]}
                      />
                      {LANE_LABELS[laneId]}
                    </button>
                    {isGraphlit ? (
                      <div
                        className="mx-1 h-6 w-px shrink-0 bg-zinc-200 dark:bg-zinc-800"
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
            <button
              type="button"
              className="flex shrink-0 items-center gap-2 rounded-md bg-zinc-900 px-5 py-2 text-sm font-semibold text-white shadow-md transition-all duration-150 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 disabled:shadow-none dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
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
      </div>
      <div className="flex w-full shrink-0 items-center justify-center gap-2 border-t border-zinc-200 bg-zinc-50 py-2 font-mono text-[11px] tracking-wider text-zinc-500 dark:border-zinc-900 dark:bg-[#09090b]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400 dark:bg-zinc-700" />
        <span>{telemetryText}</span>
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
    <div className="flex shrink-0 items-center">
      <span className="mr-2 shrink-0 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        JUDGE
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
        {enabled ? "On" : "Off"}
      </button>
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
    <div className="flex shrink-0 items-center">
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
  modelSize,
  nowMs,
  enabled,
  disabledReason,
}: {
  lane: LaneUiState;
  modelSize: ModelSize;
  nowMs: number;
  enabled: boolean;
  disabledReason?: string;
}) {
  const hasTranscript = laneHasTranscript(lane);

  return (
    <article className="flex min-h-0 flex-1 flex-col border-r border-zinc-200 bg-white last:border-r-0 dark:border-zinc-800 dark:bg-[#09090b]">
      <header className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
              <BrandIcon
                name={laneIconName(lane.id)}
                className="h-4 w-4"
                alt={LANE_LABELS[lane.id]}
              />
              {LANE_LABELS[lane.id]}
            </h2>
            <div className="mt-1 font-mono text-xs tabular-nums text-zinc-500">
              {LANE_MODEL_LABELS[lane.id][modelSize]}
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
              lane={lane}
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
  lane,
  turn,
  index,
  nowMs,
}: {
  lane: LaneUiState;
  turn: LaneTurnUiState;
  index: number;
  nowMs: number;
}) {
  return (
    <div className="border-b border-zinc-200/80 last:border-b-0 dark:border-zinc-800/50">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-200/80 px-4 py-2 dark:border-zinc-800/50">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          Turn {index + 1}
        </div>
        <div
          className={classNames(
            "flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.18em]",
            statusTone(turn.status),
          )}
        >
          <StatusIcon status={turn.status} />
          {turnStatusText(turn, nowMs)}
        </div>
      </div>
      <Section title="Prompt">
        <div className="whitespace-pre-wrap rounded-sm border border-zinc-200 bg-zinc-50 p-2 text-[13px] leading-5 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200">
          {turn.prompt}
        </div>
      </Section>
      <Section title="Answer">
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
        <details className="rounded-sm border border-zinc-200 dark:border-zinc-800">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">
            View Events
          </summary>
          <div className="max-h-64 overflow-auto border-t border-zinc-200 p-2 dark:border-zinc-800">
            <JsonView value={normalizeTurnTrace(lane, turn)} />
          </div>
        </details>
      </section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-zinc-200/80 p-4 dark:border-zinc-800/50">
      <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        {title}
      </div>
      {children}
    </section>
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

function stripEmptyJson(value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  if (Array.isArray(value)) {
    const items = value
      .map(stripEmptyJson)
      .filter((item) => item !== undefined);

    return items.length ? items : undefined;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripEmptyJson(item)] as const)
      .filter(([, item]) => item !== undefined);

    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  return value;
}

function normalizeTurnTrace(
  lane: LaneUiState,
  turn: LaneTurnUiState,
): unknown {
  return (
    stripEmptyJson({
      lane: lane.id,
      turnId: turn.turnId,
      status: turn.status,
      session: lane.session,
      result: turn.result
        ? {
            harnessName: turn.result.harnessName,
            modelLabel: turn.result.modelLabel,
            reasoningEffort: turn.result.reasoningEffort,
            effectiveReasoningEffort: turn.result.effectiveReasoningEffort,
            modelSize: turn.result.modelSize,
            durationMs: turn.result.durationMs,
            error: turn.result.error,
          }
        : undefined,
      prompt: turn.prompt,
      answer: turn.answer,
      reasoning: turn.reasoning,
      toolCalls: turn.toolCalls,
      sources: turn.sources,
      rawEvents: turn.rawEvents,
      error: turn.error,
    }) ?? null
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
            <div className="mt-2 line-clamp-4 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
              {source.text}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="border-b border-zinc-200 last:border-b-0 dark:border-zinc-800">
      <div className="border-b border-zinc-200 px-2 py-1 text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:border-zinc-800">
        {title}
      </div>
      <div className="max-h-64 overflow-auto p-2">
        <JsonView value={typeof value === "string" ? { value } : value} />
      </div>
    </div>
  );
}

function JudgePanel({ judge }: { judge: JudgeUiState }) {
  if (judge.status === "idle") {
    return null;
  }

  return (
    <aside className="max-h-64 shrink-0 overflow-y-auto border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#09090b]">
      <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
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
          <div className="font-mono text-xs tabular-nums text-zinc-500">
            {judge.status}
          </div>
        </div>
      </div>
      {judge.error ? (
        <div className="p-3 font-mono text-xs tabular-nums text-zinc-500">
          {judge.error}
        </div>
      ) : null}
      {judge.result ? (
        <div className="grid gap-0 md:grid-cols-[320px_1fr]">
          <div className="border-b border-zinc-200 p-3 md:border-b-0 md:border-r dark:border-zinc-800">
            <p className="text-base leading-7 text-zinc-800 dark:text-zinc-200">
              {judge.result.summary}
            </p>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              {judge.result.winnerReason}
            </p>
          </div>
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {judge.result.lanes.map((lane) => (
              <div key={lane.anonymousId} className="grid gap-3 p-3 md:grid-cols-[120px_1fr]">
                <div>
                  <div className="text-xs font-semibold">
                    {lane.laneId ? LANE_LABELS[lane.laneId] : lane.anonymousId}
                  </div>
                  <div className="mt-1 font-mono text-xs tabular-nums text-zinc-500">
                    {lane.overallScore}/5
                  </div>
                </div>
                <div>
                  <Gauge value={lane.overallScore} />
                  <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs text-zinc-500">
                    <span>retrieval {lane.retrievalUse}/5</span>
                    <span>inspect {lane.sourceInspection}/5</span>
                    <span>grounded {lane.groundedness}/5</span>
                    <span>risk {lane.unsupportedClaimRisk}/5</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function Gauge({ value }: { value: number }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className={classNames(
            "h-1.5 rounded-sm border border-zinc-300 dark:border-zinc-700",
            index < value
              ? "bg-zinc-900 dark:bg-zinc-100"
              : "bg-zinc-100 dark:bg-zinc-900",
          )}
        />
      ))}
    </div>
  );
}
