import type { Types } from "graphlit-client";
import type { StreamAgentArtifactCollector } from "@graphlit/agent-tools";

export type ZodRawShapeLike = Record<string, unknown>;

export interface ZodObjectLike {
  shape?: ZodRawShapeLike;
  _def?: {
    shape?: ZodRawShapeLike | (() => ZodRawShapeLike);
  };
}

export interface LabGraphlitTool {
  inputSchema: ZodObjectLike;
  tool: Types.ToolDefinitionInput;
  handler: (
    args: unknown,
    artifacts?: StreamAgentArtifactCollector,
    abortSignal?: AbortSignal,
  ) => Promise<unknown>;
}

export function toLabGraphlitTool(tool: unknown): LabGraphlitTool {
  return tool as LabGraphlitTool;
}

export function getZodRawShape(inputSchema: ZodObjectLike): ZodRawShapeLike {
  if (inputSchema.shape && typeof inputSchema.shape === "object") {
    return inputSchema.shape;
  }

  const shape = inputSchema._def?.shape;

  if (typeof shape === "function") {
    return shape();
  }

  if (shape && typeof shape === "object") {
    return shape;
  }

  return {};
}
