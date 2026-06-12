import { createLaneRoute } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLaneRoute(
  "vercel",
  async () => (await import("@/lib/lanes/vercel-ai")).runVercelAiLane,
);
