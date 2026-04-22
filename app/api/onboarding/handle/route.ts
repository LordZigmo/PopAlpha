import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { validateHandle } from "@/lib/handles";
import { ensureAppUser, claimHandle } from "@/lib/data/app-user";
import { createRateLimiter } from "@/lib/rate-limit";
import { getPostHogClient } from "@/lib/posthog-server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });

/**
 * POST /api/onboarding/handle
 *
 * Authenticated user claims a handle during onboarding.
 * Rate-limited 5/min per userId.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const rl = rateLimiter(auth.userId);
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

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
    }

    const raw = typeof body.handle === "string" ? body.handle : "";
    const result = validateHandle(raw);
    if (!result.valid) {
      return NextResponse.json({ ok: false, error: result.reason }, { status: 400 });
    }

    await ensureAppUser(auth.userId);

    const claimed = await claimHandle(auth.userId, raw.trim(), result.normalized);
    if (!claimed) {
      return NextResponse.json(
        { ok: false, error: "That handle is already taken." },
        { status: 409 },
      );
    }

    const posthog = getPostHogClient();
    posthog.identify({
      distinctId: auth.userId,
      properties: { handle: claimed.handle },
    });
    posthog.capture({
      distinctId: auth.userId,
      event: "handle_claimed",
      properties: { handle: claimed.handle },
    });

    return NextResponse.json({ ok: true, handle: claimed.handle });
  } catch (error) {
    console.error("[onboarding/handle]", error);
    return NextResponse.json(
      { ok: false, error: "Could not claim handle right now." },
      { status: 500 },
    );
  }
}
