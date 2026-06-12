import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  createGraphlitClient,
  getGraphlitCredentialError,
} from "@/lib/graphlit/client";
import { errorMessage } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CONTENT_POLL_INTERVAL_MS = 2_000;
const CONTENT_POLL_ATTEMPTS = 45;

const UriIngestRequestSchema = z.object({
  type: z.literal("uri"),
  uri: z.string().trim().url(),
  name: z.string().trim().min(1).max(240).optional(),
});

type GraphlitClient = ReturnType<typeof createGraphlitClient>;

type IngestResult = {
  type: "uri" | "file";
  contentId: string;
  name: string;
  ready: boolean;
  message: string;
};

function routeRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContentReady(
  client: GraphlitClient,
  contentId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < CONTENT_POLL_ATTEMPTS; attempt += 1) {
    const status = await client.isContentDone(contentId);

    if (status.isContentDone?.result) {
      return true;
    }

    await sleep(CONTENT_POLL_INTERVAL_MS);
  }

  return false;
}

function successResponse(result: IngestResult): NextResponse<IngestResult> {
  return NextResponse.json(result);
}

async function ingestUri(
  request: NextRequest,
  client: GraphlitClient,
): Promise<NextResponse> {
  const parsed = UriIngestRequestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const startedAt = Date.now();
  const ingestResponse = await client.ingestUri(
    parsed.data.uri,
    parsed.data.name,
    undefined,
    undefined,
    false,
  );
  const contentId = ingestResponse.ingestUri?.id;

  if (!contentId) {
    return NextResponse.json(
      { error: "Graphlit did not return a content ID for the URI." },
      { status: 502 },
    );
  }

  const ready = await waitForContentReady(client, contentId);
  const name = parsed.data.name ?? parsed.data.uri;

  console.info("[agent-harness-lab/api/ingest] uri.complete", {
    contentId,
    ready,
    elapsedMs: Date.now() - startedAt,
  });

  return successResponse({
    type: "uri",
    contentId,
    name,
    ready,
    message: ready
      ? `Ingested ${name}.`
      : `Ingested ${name}; Graphlit is still processing it.`,
  });
}

async function ingestFile(
  request: NextRequest,
  client: GraphlitClient,
): Promise<NextResponse> {
  const startedAt = Date.now();
  const formData = await request.formData();
  const fileEntry = formData.get("file");

  if (!fileEntry || typeof fileEntry === "string") {
    return NextResponse.json({ error: "File is required." }, { status: 400 });
  }

  if (fileEntry.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "File is too large. Choose a file smaller than 25 MB." },
      { status: 413 },
    );
  }

  const data = Buffer.from(await fileEntry.arrayBuffer()).toString("base64");
  const mimeType = fileEntry.type || "application/octet-stream";
  const fileModifiedDate = fileEntry.lastModified
    ? new Date(fileEntry.lastModified).toISOString()
    : undefined;
  const ingestResponse = await client.ingestEncodedFile(
    fileEntry.name || "Uploaded file",
    data,
    mimeType,
    undefined,
    fileModifiedDate,
    undefined,
    undefined,
    false,
  );
  const contentId = ingestResponse.ingestEncodedFile?.id;

  if (!contentId) {
    return NextResponse.json(
      { error: "Graphlit did not return a content ID for the file." },
      { status: 502 },
    );
  }

  const ready = await waitForContentReady(client, contentId);
  const name = fileEntry.name || "Uploaded file";

  console.info("[agent-harness-lab/api/ingest] file.complete", {
    contentId,
    ready,
    name,
    elapsedMs: Date.now() - startedAt,
  });

  return successResponse({
    type: "file",
    contentId,
    name,
    ready,
    message: ready
      ? `Ingested ${name}.`
      : `Ingested ${name}; Graphlit is still processing it.`,
  });
}

export async function POST(request: NextRequest) {
  const requestId = routeRequestId();
  const startedAt = Date.now();
  const credentialError = getGraphlitCredentialError();

  console.info("[agent-harness-lab/api/ingest] request.received", {
    requestId,
    contentType: request.headers.get("content-type"),
  });

  if (credentialError) {
    return NextResponse.json({ error: credentialError }, { status: 503 });
  }

  try {
    const client = createGraphlitClient();
    const contentType = request.headers.get("content-type") ?? "";
    const response = contentType.includes("multipart/form-data")
      ? await ingestFile(request, client)
      : await ingestUri(request, client);

    console.info("[agent-harness-lab/api/ingest] request.complete", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      status: response.status,
    });

    return response;
  } catch (error) {
    const message = errorMessage(error);

    console.error("[agent-harness-lab/api/ingest] request.failed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error: message,
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
