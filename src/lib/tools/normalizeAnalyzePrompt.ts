import type { LabGraphlitTool } from "@/lib/tools/types";

type AnalyzeEvidencePurpose =
  | "retrieve_project_content"
  | "inspect_known_content"
  | "search_public_web"
  | "map_site"
  | "cross_check"
  | "summarize_only";

type AnalyzePriority = "required" | "preferred";
type AnalyzeIntent =
  | "direct_answer"
  | "factual_lookup"
  | "current_lookup"
  | "summarization"
  | "comparison"
  | "deep_research"
  | "analysis"
  | "creative"
  | "unclear";
type AnalyzeComplexity = "simple" | "standard" | "deep";
type AnalyzeSourceScope =
  | "provided_prompt"
  | "uploaded_or_ingested_content"
  | "public_web"
  | "mapped_site";
type AnalyzeAnswerShape =
  | "short_answer"
  | "bullets"
  | "report"
  | "table"
  | "blog_post"
  | "comparison"
  | "debug_explanation"
  | "other";
type AnalyzeCitationExpectation =
  | "none"
  | "light"
  | "source_labels"
  | "explicit_urls";
type AnalyzeConstraintType =
  | "recency"
  | "source_quality"
  | "scope"
  | "format"
  | "comparison"
  | "uncertainty";
type AnalyzeNextStepTool =
  | "retrieve_contents"
  | "inspect_content"
  | "web_search"
  | "web_map"
  | "read_resource"
  | "list_resources"
  | "count_contents"
  | "answer_directly";

type AnalyzeEvidencePlanItem = {
  purpose: AnalyzeEvidencePurpose;
  queryOrTarget: string;
  priority: AnalyzePriority;
  reason: string;
};

type AnalyzeConstraint = {
  type: AnalyzeConstraintType;
  instruction: string;
};

type AnalyzeAnswerContract = {
  shape: AnalyzeAnswerShape;
  mustInclude: string[];
  citationExpectation: AnalyzeCitationExpectation;
  gapHandling: string;
};

type AnalyzeNextStep = {
  tool: AnalyzeNextStepTool;
  parameters?: Record<string, unknown>;
  reason: string;
};

type AnalyzePromptResult = {
  type: "prompt_analysis";
  prompt: string;
  retrievalNeeded: boolean;
  skipReason?: string | null;
  intent: AnalyzeIntent;
  complexity: AnalyzeComplexity;
  sourceScopes: AnalyzeSourceScope[];
  subjects: Array<{
    text: string;
    kind: string;
    role?: string;
  }>;
  evidencePlan: AnalyzeEvidencePlanItem[];
  constraints: AnalyzeConstraint[];
  answerContract: AnalyzeAnswerContract;
  nextStep?: AnalyzeNextStep;
};

const DEEP_RESEARCH_MUST_INCLUDE = [
  "definition and framing",
  "taxonomy",
  "canonical systems and papers",
  "state-of-the-art techniques",
  "storage and architecture tradeoffs",
  "benchmarks and evaluation",
  "limitations, risks, and failure modes",
  "practical architecture guidance",
  "future directions",
  "key sources or bibliography",
];

const LONG_FORM_RESEARCH_FORMAT_INSTRUCTION =
  "For long-form technical research deliverables, use a scannable article structure with clear headings, sufficient depth for the requested scope, comparison tables where useful, practical guidance, and a categorized source list or bibliography. Do not impose terse one-line bullet or 2-3 sentence paragraph limits unless the user explicitly requested them.";

const NEXT_STEP_TOOLS = new Set<AnalyzeNextStepTool>([
  "retrieve_contents",
  "inspect_content",
  "web_search",
  "web_map",
  "read_resource",
  "list_resources",
  "count_contents",
  "answer_directly",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function includesCaseInsensitive(values: string[], next: string): boolean {
  const normalized = next.toLowerCase();

  return values.some((value) => value.toLowerCase() === normalized);
}

function appendUnique(values: string[], additions: string[]): string[] {
  const next = [...values];

  for (const item of additions) {
    if (!includesCaseInsensitive(next, item)) {
      next.push(item);
    }
  }

  return next;
}

function upsertConstraint(
  constraints: AnalyzeConstraint[],
  type: AnalyzeConstraintType,
  instruction: string,
): AnalyzeConstraint[] {
  if (constraints.some((constraint) => constraint.type === type)) {
    return constraints;
  }

  return [...constraints, { type, instruction }];
}

function replaceConstraint(
  constraints: AnalyzeConstraint[],
  type: AnalyzeConstraintType,
  instruction: string,
): AnalyzeConstraint[] {
  return [
    ...constraints.filter((constraint) => constraint.type !== type),
    { type, instruction },
  ];
}

function firstEvidenceStep(
  evidencePlan: AnalyzeEvidencePlanItem[],
): AnalyzeEvidencePlanItem | undefined {
  return (
    evidencePlan.find((item) => item.priority === "required") ??
    evidencePlan[0]
  );
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function nextStepForEvidenceStep(
  step: AnalyzeEvidencePlanItem,
): AnalyzeNextStep {
  switch (step.purpose) {
    case "retrieve_project_content":
      return {
        tool: "retrieve_contents",
        parameters: { search: step.queryOrTarget, limit: 8 },
        reason: step.reason,
      };
    case "inspect_known_content":
      return {
        tool: "inspect_content",
        parameters: step.queryOrTarget.startsWith("contents://")
          ? { resourceUri: step.queryOrTarget, mode: "markdown" }
          : { id: step.queryOrTarget, mode: "markdown" },
        reason: step.reason,
      };
    case "map_site":
      return {
        tool: "web_map",
        parameters: { url: step.queryOrTarget },
        reason: step.reason,
      };
    case "search_public_web":
    case "cross_check":
      return {
        tool: "web_search",
        parameters: {
          query: step.queryOrTarget,
          searchService: "PARALLEL",
          limit: 5,
        },
        reason: step.reason,
      };
    case "summarize_only":
    default:
      return {
        tool: "answer_directly",
        reason: step.reason,
      };
  }
}

function validNextStep(value: unknown): AnalyzeNextStep | undefined {
  if (!isRecord(value) || typeof value.tool !== "string") {
    return undefined;
  }

  const tool = value.tool as AnalyzeNextStepTool;

  if (!NEXT_STEP_TOOLS.has(tool)) {
    return undefined;
  }

  return {
    tool,
    parameters: isRecord(value.parameters) ? value.parameters : undefined,
    reason:
      typeof value.reason === "string" && value.reason.trim()
        ? value.reason
        : "Immediate next step selected from prompt analysis.",
  };
}

function normalizeExistingNextStep(
  result: AnalyzePromptResult,
  nextStep: AnalyzeNextStep,
): AnalyzeNextStep {
  if (nextStep.tool !== "web_search") {
    return nextStep;
  }

  const parameters = isRecord(nextStep.parameters)
    ? nextStep.parameters
    : {};
  const query =
    typeof parameters.query === "string" && parameters.query.trim()
      ? parameters.query
      : firstEvidenceStep(result.evidencePlan)?.queryOrTarget ?? result.prompt;

  return {
    ...nextStep,
    parameters: {
      ...parameters,
      query,
      searchService:
        typeof parameters.searchService === "string"
          ? parameters.searchService
          : "PARALLEL",
      limit: 5,
    },
  };
}

function normalizeNextStep(result: AnalyzePromptResult): AnalyzeNextStep {
  const existing = validNextStep(result.nextStep);

  if (existing) {
    return normalizeExistingNextStep(result, existing);
  }

  if (!result.retrievalNeeded) {
    return {
      tool: "answer_directly",
      reason: result.skipReason ?? "Retrieval is not needed for this prompt.",
    };
  }

  const step = firstEvidenceStep(result.evidencePlan);

  if (step) {
    return nextStepForEvidenceStep(step);
  }

  if (result.sourceScopes.includes("public_web")) {
    return {
      tool: "web_search",
      parameters: {
        query: result.prompt,
        searchService: "PARALLEL",
        limit: 5,
      },
      reason:
        "No explicit evidence step was provided; start with a public web search for the user's prompt.",
    };
  }

  return {
    tool: "retrieve_contents",
    parameters: { search: result.prompt, limit: 8 },
    reason:
      "No explicit evidence step was provided; start with Graphlit project retrieval for the user's prompt.",
  };
}

function normalizeCitationExpectation(
  result: AnalyzePromptResult,
): AnalyzeCitationExpectation {
  if (
    result.sourceScopes.includes("public_web") ||
    result.evidencePlan.some(
      (item) =>
        item.purpose === "search_public_web" ||
        item.purpose === "cross_check" ||
        isUrl(item.queryOrTarget),
    )
  ) {
    return "explicit_urls";
  }

  if (
    result.sourceScopes.includes("uploaded_or_ingested_content") ||
    result.evidencePlan.some(
      (item) =>
        item.purpose === "retrieve_project_content" ||
        item.purpose === "inspect_known_content",
    )
  ) {
    return "source_labels";
  }

  return result.answerContract.citationExpectation;
}

function normalizeConstraints(result: AnalyzePromptResult): AnalyzeConstraint[] {
  const hasPublicWeb = result.sourceScopes.includes("public_web");
  const isDeepResearch =
    result.intent === "deep_research" || result.complexity === "deep";
  let constraints = [...result.constraints];

  if (hasPublicWeb) {
    constraints = upsertConstraint(
      constraints,
      "recency",
      "Use current sources where useful; include concrete dates for current, recent, latest, or time-sensitive claims.",
    );
    constraints = upsertConstraint(
      constraints,
      "source_quality",
      "Prefer primary sources, official documentation, papers, and source-of-record pages; use secondary sources for synthesis only.",
    );
  }

  if (isDeepResearch) {
    constraints = upsertConstraint(
      constraints,
      "scope",
      "Cover definition/framing, taxonomy, canonical systems or papers, SOTA techniques, evaluation, risks, practical guidance, and future directions.",
    );
    constraints = upsertConstraint(
      constraints,
      "uncertainty",
      "Flag emerging, contested, weakly supported, or fast-moving claims instead of presenting them as settled.",
    );
  }

  if (
    result.answerContract.shape === "blog_post" ||
    result.answerContract.shape === "report"
  ) {
    constraints = replaceConstraint(
      constraints,
      "format",
      LONG_FORM_RESEARCH_FORMAT_INSTRUCTION,
    );
  }

  if (result.intent === "comparison") {
    constraints = upsertConstraint(
      constraints,
      "comparison",
      "Retrieve or evaluate each side separately before synthesizing tradeoffs.",
    );
  }

  return constraints;
}

function normalizeAnswerContract(
  result: AnalyzePromptResult,
): AnalyzeAnswerContract {
  const isDeepResearch =
    result.intent === "deep_research" || result.complexity === "deep";
  const mustInclude = isDeepResearch
    ? appendUnique(result.answerContract.mustInclude, DEEP_RESEARCH_MUST_INCLUDE)
    : result.answerContract.mustInclude;

  return {
    ...result.answerContract,
    mustInclude,
    citationExpectation: normalizeCitationExpectation(result),
  };
}

function normalizeAnalyzePromptResult(output: unknown): unknown {
  if (!isRecord(output) || output.type !== "prompt_analysis") {
    return output;
  }

  const result = output as AnalyzePromptResult;

  return {
    ...result,
    constraints: normalizeConstraints(result),
    answerContract: normalizeAnswerContract(result),
    nextStep: normalizeNextStep(result),
  };
}

export function withNormalizedAnalyzePromptTool(
  tool: LabGraphlitTool,
): LabGraphlitTool {
  return {
    ...tool,
    handler: async (args, artifacts, abortSignal) =>
      normalizeAnalyzePromptResult(
        await tool.handler(args, artifacts, abortSignal),
      ),
  };
}
