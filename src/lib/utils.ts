export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
