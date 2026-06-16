import "server-only";

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /Cannot connect to API/i,
  /\bfetch failed\b/i,
  /failed to fetch/i,
  /Headers Timeout Error/i,
  /Connect Timeout Error/i,
  /SocketError/i,
  /socket connection (?:was )?closed/i,
  /other side closed/i,
  /\bterminated\b/i,
  /read ECONNRESET/i,
  /Mastra Anthropic stream (?:step|chunk) timed out/i,
];

const RETRYABLE_STATUS_CODES = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504,
  529,
]);

type ErrorNode = {
  name?: string;
  message?: string;
  code?: string;
  statusCode?: number;
  isRetryable?: boolean;
};

export type ProviderErrorSummary = ErrorNode & {
  cause?: ErrorNode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];

  return typeof value === "boolean" ? value : undefined;
}

function collectErrorNodes(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): ErrorNode[] {
  if (!value || depth > 5) {
    return [];
  }

  if (value instanceof Error || isRecord(value)) {
    const objectValue = value as Error & Record<string, unknown>;

    if (seen.has(objectValue)) {
      return [];
    }

    seen.add(objectValue);

    const node: ErrorNode = {
      name: stringField(objectValue, "name"),
      message: stringField(objectValue, "message"),
      code: stringField(objectValue, "code"),
      statusCode: numberField(objectValue, "statusCode"),
      isRetryable: booleanField(objectValue, "isRetryable"),
    };
    const nodes = [node];

    nodes.push(...collectErrorNodes(objectValue.cause, seen, depth + 1));
    nodes.push(...collectErrorNodes(objectValue.lastError, seen, depth + 1));

    if (Array.isArray(objectValue.errors)) {
      for (const item of objectValue.errors.slice(0, 8)) {
        nodes.push(...collectErrorNodes(item, seen, depth + 1));
      }
    }

    return nodes;
  }

  return [{ message: String(value) }];
}

function matchesTransientMessage(value: string | undefined): boolean {
  return Boolean(
    value && TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(value)),
  );
}

export function summarizeProviderError(error: unknown): ProviderErrorSummary {
  const nodes = collectErrorNodes(error);
  const primary = nodes[0] ?? { message: String(error) };
  const cause = nodes.find(
    (node, index) =>
      index > 0 && (node.name || node.message || node.code || node.statusCode),
  );

  return {
    name: primary.name,
    message: primary.message,
    code: primary.code ?? nodes.find((node) => node.code !== undefined)?.code,
    statusCode:
      primary.statusCode ??
      nodes.find((node) => node.statusCode !== undefined)?.statusCode,
    isRetryable:
      primary.isRetryable ??
      nodes.find((node) => node.isRetryable !== undefined)?.isRetryable,
    cause,
  };
}

export function isTransientProviderConnectionError(error: unknown): boolean {
  const nodes = collectErrorNodes(error);

  for (const node of nodes) {
    if (node.code && TRANSIENT_ERROR_CODES.has(node.code)) {
      return true;
    }

    if (
      matchesTransientMessage(node.name) ||
      matchesTransientMessage(node.message)
    ) {
      return true;
    }

    if (
      node.isRetryable === true &&
      (node.statusCode === undefined ||
        RETRYABLE_STATUS_CODES.has(node.statusCode))
    ) {
      return true;
    }
  }

  return false;
}
