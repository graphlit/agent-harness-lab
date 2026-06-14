import "server-only";

import { LaneRunRecorder } from "@/lib/lanes/recorder";

type ReadableTextStream =
  | AsyncIterable<string>
  | ReadableStream<string>
  | NodeJS.ReadableStream;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function lastStructuredStepText(steps: unknown): string {
  if (!Array.isArray(steps)) {
    return "";
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];

    if (!isRecord(step) || typeof step.text !== "string") {
      continue;
    }

    const text = step.text.trim();

    if (text) {
      return text;
    }
  }

  return "";
}

export function sentenceChunk(buffer: string): string | null {
  const match = /[.!?](?:["')\]]+)?(?:\s+|$)|[\r\n]+/.exec(buffer);

  if (!match) {
    return null;
  }

  return buffer.slice(0, match.index + match[0].length);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      Symbol.asyncIterator in value &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ] === "function",
  );
}

function isWebReadableStream(value: unknown): value is ReadableStream<string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "getReader" in value &&
      typeof (value as { getReader?: unknown }).getReader === "function",
  );
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return new TextDecoder().decode(chunk);
  }

  return chunk == null ? "" : String(chunk);
}

export async function emitTextStream(
  stream: ReadableTextStream,
  recorder: LaneRunRecorder,
): Promise<void> {
  if (isAsyncIterable(stream)) {
    for await (const chunk of stream) {
      await recorder.emitDelta(chunkToText(chunk));
    }

    return;
  }

  if (isWebReadableStream(stream)) {
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        await recorder.emitDelta(chunkToText(value));
      }
    } finally {
      reader.releaseLock();
    }

    return;
  }

  throw new Error("Unsupported text stream shape.");
}
