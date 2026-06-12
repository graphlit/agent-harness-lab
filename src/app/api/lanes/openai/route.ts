import { createLaneRoute } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLaneRoute(
  "openai",
  async () => (await import("@/lib/lanes/openai-agents")).runOpenAiAgentsLane,
);
