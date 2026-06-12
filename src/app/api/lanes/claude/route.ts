import { createLaneRoute } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLaneRoute(
  "claude",
  async () => (await import("@/lib/lanes/claude")).runClaudeLane,
);
