import { createLaneRoute } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLaneRoute(
  "google",
  async () => (await import("@/lib/lanes/google")).runGoogleLane,
);
