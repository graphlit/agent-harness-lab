import { runClaudeLane } from "@/lib/lanes/claude";
import { runGoogleLane } from "@/lib/lanes/google";
import { runGraphlitLane } from "@/lib/lanes/graphlit";
import { runLangGraphLane } from "@/lib/lanes/langgraph";
import { runMastraLane } from "@/lib/lanes/mastra";
import { runOpenAiAgentsLane } from "@/lib/lanes/openai-agents";
import { runVercelAiLane } from "@/lib/lanes/vercel-ai";
import type { LaneId, LaneRunContext, LaneRunResult } from "@/lib/types";

export const laneRunners: Record<
  LaneId,
  (context: LaneRunContext) => Promise<LaneRunResult>
> = {
  graphlit: runGraphlitLane,
  openai: runOpenAiAgentsLane,
  vercel: runVercelAiLane,
  langgraph: runLangGraphLane,
  mastra: runMastraLane,
  claude: runClaudeLane,
  google: runGoogleLane,
};
