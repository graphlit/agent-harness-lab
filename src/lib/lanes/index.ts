import { runClaudeLane } from "@/lib/lanes/claude";
import { runGoogleLane } from "@/lib/lanes/google";
import { runGraphlitLane } from "@/lib/lanes/graphlit";
import { runMastraLane } from "@/lib/lanes/mastra";
import { runOpenAiAgentsLane } from "@/lib/lanes/openai-agents";
import type { LaneId, LaneRunContext, LaneRunResult } from "@/lib/types";

export const laneRunners: Record<
  LaneId,
  (context: LaneRunContext) => Promise<LaneRunResult>
> = {
  graphlit: runGraphlitLane,
  openai: runOpenAiAgentsLane,
  mastra: runMastraLane,
  claude: runClaudeLane,
  google: runGoogleLane,
};
