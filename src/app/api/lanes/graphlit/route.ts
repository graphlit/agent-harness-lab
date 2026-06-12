import { createLaneRoute } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLaneRoute(
  "graphlit",
  async () => (await import("@/lib/lanes/graphlit")).runGraphlitLane,
);
