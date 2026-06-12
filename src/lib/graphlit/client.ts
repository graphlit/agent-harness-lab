import "server-only";

import { Graphlit } from "graphlit-client";

const DEFAULT_GRAPHLIT_API_URL = "https://data-scus.graphlit.io/api/v1/graphql";

function configuredGraphlitApiUrl(): string {
  return process.env.GRAPHLIT_API_URL?.trim() || DEFAULT_GRAPHLIT_API_URL;
}

function describeEnvValue(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    return "missing";
  }

  return value.length <= 8 ? "set" : `set (...${value.slice(-8)})`;
}

export function createGraphlitClient(): Graphlit {
  return new Graphlit({
    organizationId: process.env.GRAPHLIT_ORGANIZATION_ID,
    environmentId: process.env.GRAPHLIT_ENVIRONMENT_ID,
    jwtSecret: process.env.GRAPHLIT_JWT_SECRET,
    apiUri: configuredGraphlitApiUrl(),
  });
}

export function getGraphlitClientDiagnostics(): Record<string, string | boolean> {
  return {
    apiUri: configuredGraphlitApiUrl(),
    usingDefaultApiUri: !process.env.GRAPHLIT_API_URL?.trim(),
    organizationId: describeEnvValue("GRAPHLIT_ORGANIZATION_ID"),
    environmentId: describeEnvValue("GRAPHLIT_ENVIRONMENT_ID"),
    jwtSecret: process.env.GRAPHLIT_JWT_SECRET ? "set" : "missing",
  };
}

export function getGraphlitCredentialError(): string | undefined {
  const missing = [
    "GRAPHLIT_ORGANIZATION_ID",
    "GRAPHLIT_ENVIRONMENT_ID",
    "GRAPHLIT_JWT_SECRET",
  ].filter((name) => !process.env[name]);

  return missing.length
    ? `Missing required Graphlit environment variables: ${missing.join(", ")}`
    : undefined;
}
