import type { Graphlit } from "graphlit-client";

import {
  getZodRawShape,
  type LabGraphlitTool,
  type ZodObjectLike,
} from "@/lib/tools/types";

const URL_INSPECT_TIMEOUT_MS = 120_000;
const URL_INSPECT_POLL_INTERVAL_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function extendInspectContentSchema(inputSchema: ZodObjectLike): ZodObjectLike {
  const schema = inputSchema as ZodObjectLike & {
    extend?: (shape: Record<string, unknown>) => ZodObjectLike;
  };

  if (typeof schema.extend !== "function") {
    return inputSchema;
  }

  const shape = getZodRawShape(inputSchema);
  const stringLikeSchema = shape.resourceUri ?? shape.id;

  if (
    !stringLikeSchema ||
    typeof (stringLikeSchema as { describe?: unknown }).describe !== "function"
  ) {
    return inputSchema;
  }

  return schema.extend({
    uri: (
      stringLikeSchema as {
        describe: (description: string) => unknown;
      }
    ).describe(
      "Public http(s) URL to ingest or reuse as Graphlit content before inspection. Use this for normal web URLs; use resourceUri only for contents:// resource URIs.",
    ),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function waitForContentReady(
  client: Graphlit,
  contentId: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= URL_INSPECT_TIMEOUT_MS) {
    throwIfAborted(abortSignal);

    const status = await client.isContentDone(contentId);
    if (status.isContentDone?.result) {
      return true;
    }

    await sleep(URL_INSPECT_POLL_INTERVAL_MS);
  }

  return false;
}

async function findExistingContentIdForUrl(
  client: Graphlit,
  url: string,
): Promise<string | undefined> {
  const response = await client.queryContents({
    uri: url,
    limit: 1,
  });

  return response.contents?.results?.[0]?.id ?? undefined;
}

async function ensureContentForUrl(
  client: Graphlit,
  url: string,
  abortSignal?: AbortSignal,
): Promise<{
  contentId: string;
  reusedExistingContent: boolean;
  ready: boolean;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  const existingContentId = await findExistingContentIdForUrl(client, url);

  if (existingContentId) {
    const ready = await waitForContentReady(
      client,
      existingContentId,
      abortSignal,
    );

    return {
      contentId: existingContentId,
      reusedExistingContent: true,
      ready,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const ingestResponse = await client.ingestUri(
    url,
    undefined,
    undefined,
    undefined,
    false,
  );
  const contentId = ingestResponse.ingestUri?.id;

  if (!contentId) {
    throw new Error(`Graphlit did not return a content ID for URL: ${url}`);
  }

  const ready = await waitForContentReady(client, contentId, abortSignal);

  return {
    contentId,
    reusedExistingContent: false,
    ready,
    elapsedMs: Date.now() - startedAt,
  };
}

export function withUrlInspectContent(
  inspectContentTool: LabGraphlitTool,
  client: Graphlit,
): LabGraphlitTool {
  return {
    ...inspectContentTool,
    inputSchema: extendInspectContentSchema(inspectContentTool.inputSchema),
    tool: {
      ...inspectContentTool.tool,
      description:
        "Inspect one Graphlit content item returned by retrieve_contents, using its id or contents:// resource URI. To inspect a normal public web page, pass uri with the http(s) URL; the tool will ingest or reuse the URL in Graphlit, wait for processing, then return markdown/text for the resulting content.",
    },
    handler: async (rawArgs, artifacts, abortSignal) => {
      throwIfAborted(abortSignal);

      if (!isRecord(rawArgs)) {
        return inspectContentTool.handler(rawArgs, artifacts, abortSignal);
      }

      const urlCandidate = isHttpUrl(rawArgs.uri)
        ? rawArgs.uri.trim()
        : isHttpUrl(rawArgs.resourceUri)
          ? rawArgs.resourceUri.trim()
          : isHttpUrl(rawArgs.id)
          ? rawArgs.id.trim()
          : undefined;

      if (!urlCandidate) {
        return inspectContentTool.handler(rawArgs, artifacts, abortSignal);
      }

      const urlInspection = await ensureContentForUrl(
        client,
        urlCandidate,
        abortSignal,
      );

      artifacts?.addPending(Promise.resolve({ id: urlInspection.contentId }));

      const result = await inspectContentTool.handler(
        {
          ...rawArgs,
          id: urlInspection.contentId,
          uri: undefined,
          resourceUri: undefined,
        },
        artifacts,
        abortSignal,
      );

      return isRecord(result)
        ? {
            ...result,
            urlInspection: {
              url: urlCandidate,
              ...urlInspection,
            },
          }
        : result;
    },
  };
}
