import { NextResponse } from "next/server";
import { validateHandle } from "@/lib/handles";
import { dbPublic } from "@/lib/db";
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

  const db = dbPublic();
  const { data, error } = await db.rpc("is_handle_available", {
    desired_handle_norm: result.normalized,
  });

  if (error) {
    console.error("[handles/availability]", error.message);
    return NextResponse.json({ ok: false, error: "Internal error." }, { status: 500 });
  }

  const available = data === true;
  return NextResponse.json({ ok: true, available });
}
