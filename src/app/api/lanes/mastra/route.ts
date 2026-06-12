import { createLaneRoute } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLaneRoute(
  "mastra",
  async () => (await import("@/lib/lanes/mastra")).runMastraLane,
);
