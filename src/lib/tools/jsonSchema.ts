import { zodToJsonSchema } from "zod-to-json-schema";

import type { ZodObjectLike } from "@/lib/tools/types";

type JsonSchemaObject = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripUnsupportedSchemaFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUnsupportedSchemaFields);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== "$schema" && key !== "definitions" && key !== "$defs",
      )
      .map(([key, nestedValue]) => [
        key,
        stripUnsupportedSchemaFields(nestedValue),
      ]),
  );
}

export function toNonStrictJsonSchema(schema: ZodObjectLike): JsonSchemaObject {
  const jsonSchema = zodToJsonSchema(schema as never, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });
  const stripped = stripUnsupportedSchemaFields(jsonSchema);

  return isRecord(stripped)
    ? stripped
    : { type: "object", properties: {}, additionalProperties: false };
}
