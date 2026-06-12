import type {
  StreamAgentToolHandlers,
} from "@graphlit/agent-tools";

import type { LaneRunRecorder } from "@/lib/lanes/recorder";
import type { LabGraphlitTool } from "@/lib/tools/types";
import { createId, errorMessage } from "@/lib/utils";

export function recordGraphlitToolCall(
  graphlitTool: LabGraphlitTool,
  recorder: LaneRunRecorder,
): LabGraphlitTool {
  return {
    ...graphlitTool,
    handler: async (args, artifacts, abortSignal) => {
      const callId = createId(`${recorder.laneId}-${graphlitTool.tool.name}`);
      await recorder.recordToolStarted(callId, graphlitTool.tool.name, args);

      try {
        const result = await graphlitTool.handler(args, artifacts, abortSignal);
        await recorder.recordToolCompleted(callId, result);
        return result;
      } catch (error) {
        await recorder.recordToolFailed(callId, errorMessage(error));
        throw error;
      }
    },
  };
}

export function toStreamAgentToolHandlers(
  tools: LabGraphlitTool[],
): StreamAgentToolHandlers {
  return Object.fromEntries(
    tools.map((item) => [item.tool.name, item.handler]),
  ) as StreamAgentToolHandlers;
}
