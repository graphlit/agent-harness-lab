export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ERROR_DETAIL_MAX_STRING_LENGTH = 4000;
const SENSITIVE_ERROR_KEY_PATTERN =
  /authorization|api[_-]?key|token|secret|password|cookie|jwt/i;

function redactText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(
      /(authorization|api[_-]?key|token|secret|password|cookie)(["'\s:=]+)([^"'\s,}]+)/gi,
      "$1$2[redacted]",
    );
}

function truncateErrorText(value: string): string {
  const redacted = redactText(value);

  return redacted.length <= ERROR_DETAIL_MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, ERROR_DETAIL_MAX_STRING_LENGTH)}...`;
}

function redactErrorValue(
  key: string,
  value: unknown,
  depth = 0,
): unknown {
  if (SENSITIVE_ERROR_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    return truncateErrorText(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (depth >= 3) {
    return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => redactErrorValue(key, item, depth + 1));
  }

  try {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, childValue]) => [
          childKey,
          redactErrorValue(childKey, childValue, depth + 1),
        ],
      ),
    );
  } catch {
    return "[unavailable]";
  }
}

function collectErrorProperties(error: Error): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const errorRecord = error as Error & Record<string, unknown>;

  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }

    properties[key] = redactErrorValue(key, errorRecord[key]);
  }

  return properties;
}

export function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    const errorWithCause = error as Error & { cause?: unknown };
    const properties = collectErrorProperties(error);

    if (error.stack) {
      details.stack = truncateErrorText(error.stack);
    }

    if (errorWithCause.cause !== undefined && depth < 3) {
      details.cause = errorDetails(errorWithCause.cause, depth + 1);
    }

    if (Object.keys(properties).length > 0) {
      details.properties = properties;
    }

    return details;
  }

  return {
    message: errorMessage(error),
    value: redactErrorValue("value", safeJson(error)),
  };
}

export function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `${prefix}-${random}`;
}

export function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function summarizeJson(value: unknown, maxLength = 360): string {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(safeJson(value), null, 2) ?? "";

  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function elapsedMs(startedAt: string, completedAt = nowIso()): number {
  return Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime(),
  );
}
