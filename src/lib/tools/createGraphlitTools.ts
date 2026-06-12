import type { Graphlit } from "graphlit-client";
import {
  createIngestUrlTool,
  createInspectContentTool,
  createRetrieveContentsTool,
  createWaitContentDoneTool,
  createWebSearchTool,
} from "@graphlit/agent-tools";

import type { LabGraphlitTool } from "@/lib/tools/types";
import { toLabGraphlitTool } from "@/lib/tools/types";

export function createGraphlitTools(client: Graphlit): LabGraphlitTool[] {
  return [
    toLabGraphlitTool(createRetrieveContentsTool(client, {
      defaultLimit: 8,
      maxLimit: 25,
      maxTextLength: 3_500,
    })),
    toLabGraphlitTool(createInspectContentTool(client, {
      maxTextLength: 10_000,
    })),
    toLabGraphlitTool(createWebSearchTool(client, {
      defaultLimit: 8,
      maxLimit: 12,
    })),
    toLabGraphlitTool(createIngestUrlTool(client, {
      defaultWaitForCompletion: false,
    })),
    toLabGraphlitTool(createWaitContentDoneTool(client, {
      defaultTimeoutMs: 90_000,
      defaultPollIntervalMs: 2_000,
    })),
  ];
}
