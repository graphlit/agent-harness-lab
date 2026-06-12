import { existsSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function routeRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function describeEnvValue(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    return "missing";
  }

  return value.length <= 8 ? "set" : `set (...${value.slice(-8)})`;
}

function routeEnvironmentDiagnostics(): Record<string, string | boolean> {
  const cwd = process.cwd();
  const envLocalPath = path.join(cwd, ".env.local");

  return {
    cwd,
    envLocalPath,
    envLocalExists: existsSync(envLocalPath),
    graphlitOrganizationId: describeEnvValue("GRAPHLIT_ORGANIZATION_ID"),
    graphlitEnvironmentId: describeEnvValue("GRAPHLIT_ENVIRONMENT_ID"),
    graphlitJwtSecret: process.env.GRAPHLIT_JWT_SECRET ? "set" : "missing",
    graphlitApiUrl: process.env.GRAPHLIT_API_URL?.trim() || "default",
    openAiApiKey: process.env.OPENAI_API_KEY ? "set" : "missing",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? "set" : "missing",
    geminiApiKey: process.env.GEMINI_API_KEY ? "set" : "missing",
  };
}

export async function GET(request: Request) {
  const requestId = routeRequestId();

  console.info("[agent-harness-lab/api/bootstrap] health.received", {
    requestId,
    method: request.method,
    url: request.url,
    environment: routeEnvironmentDiagnostics(),
  });

  return NextResponse.json({
    ok: true,
    route: "/api/bootstrap",
    requestId,
    environment: routeEnvironmentDiagnostics(),
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const requestId = routeRequestId();
  const startedAt = Date.now();
  let diagnostics: Record<string, string | boolean> =
    routeEnvironmentDiagnostics();

  console.info("[agent-harness-lab/api/bootstrap] request.received", {
    requestId,
    method: request.method,
    url: request.url,
    environment: diagnostics,
  });

  const pendingLog = setInterval(() => {
    console.warn("[agent-harness-lab/api/bootstrap] request.pending", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      diagnostics,
    });
  }, 10_000);

  try {
    console.info("[agent-harness-lab/api/bootstrap] diagnostics.import.start", {
      requestId,
    });
    const { getGraphlitClientDiagnostics } = await import(
      "@/lib/graphlit/client"
    );
    diagnostics = getGraphlitClientDiagnostics();

    console.info("[agent-harness-lab/api/bootstrap] request.start", {
      requestId,
      diagnostics,
    });

    console.info("[agent-harness-lab/api/bootstrap] bootstrap.import.start", {
      requestId,
    });
    const { bootstrapAgentHarnessLab } = await import(
      "@/lib/graphlit/bootstrap"
    );
    console.info("[agent-harness-lab/api/bootstrap] bootstrap.import.success", {
      requestId,
    });

    const status = await bootstrapAgentHarnessLab();
    console.info("[agent-harness-lab/api/bootstrap] request.success", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      graphlitReady: status.graphlit.ready,
      bootstrapUpToDate: status.bootstrapUpToDate,
      rebootstrapPerformed: status.rebootstrapPerformed,
      graphlitError: status.graphlit.error,
    });

    return NextResponse.json(status);
  } catch (error) {
    console.error("[agent-harness-lab/api/bootstrap] request.failed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : String(error),
    });

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  } finally {
    clearInterval(pendingLog);
  }
}
