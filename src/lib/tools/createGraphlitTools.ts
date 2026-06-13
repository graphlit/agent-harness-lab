import type { Graphlit } from "graphlit-client";
import {
  createCountContentsTool,
  createInspectContentTool,
  createListResourcesTool,
  createReadResourceTool,
  createRetrieveContentsTool,
  createWebMapTool,
  createWebSearchTool,
  type ResourceKind,
} from "@graphlit/agent-tools";

import type { LabGraphlitTool } from "@/lib/tools/types";
import { toLabGraphlitTool } from "@/lib/tools/types";

const READ_ONLY_RESOURCE_KINDS: ResourceKind[] = [
  "contents",
  "collections",
  "feeds",
];

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
    toLabGraphlitTool(createCountContentsTool(client)),
    toLabGraphlitTool(createListResourcesTool(client, {
      allowedKinds: READ_ONLY_RESOURCE_KINDS,
      defaultKinds: READ_ONLY_RESOURCE_KINDS,
      defaultLimit: 12,
      maxLimit: 25,
    })),
    toLabGraphlitTool(createReadResourceTool(client, {
      allowedKinds: READ_ONLY_RESOURCE_KINDS,
      maxTextLength: 10_000,
      relatedLimit: 12,
    })),
    toLabGraphlitTool(createWebSearchTool(client, {
      defaultLimit: 8,
      maxLimit: 12,
    })),
    toLabGraphlitTool(createWebMapTool(client)),
  ];
}
