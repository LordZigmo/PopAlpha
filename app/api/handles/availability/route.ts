import { NextResponse } from "next/server";
import { validateHandle } from "@/lib/handles";
import { dbAdmin } from "@/lib/db/admin";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

/**
 * GET /api/handles/availability?handle=zig
 *
 * Public endpoint — no auth required.
 * Rate-limited 30/min per IP.
 */
export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimiter(ip);
  if (!rl.allowed) {
    return new NextResponse(
      JSON.stringify({ ok: false, error: "Rate limit exceeded." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
        },
      },
    );
  }

  const handle = new URL(req.url).searchParams.get("handle") ?? "";
  const result = validateHandle(handle);

  if (!result.valid) {
    return NextResponse.json({ ok: false, available: false, reason: result.reason });
  }

  const db = dbAdmin();
  const { count, error } = await db
    .from("app_users")
    .select("*", { count: "exact", head: true })
    .eq("handle_norm", result.normalized);

  if (error) {
    console.error("[handles/availability]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const available = (count ?? 0) === 0;
  return NextResponse.json({ ok: true, available });
}
