import { NextResponse } from "next/server";
import { resolveAuthContext } from "@/lib/auth/context";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

type WaitlistTier = "Ace" | "Elite";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidTier(value: unknown): value is WaitlistTier {
  return value === "Ace" || value === "Elite";
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as {
      email?: string;
      tier?: string;
    } | null;

    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const tier = body?.tier;

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
    }

    if (!isValidTier(tier)) {
      return NextResponse.json({ ok: false, error: "Invalid waitlist tier." }, { status: 400 });
    }

    const auth = await resolveAuthContext(req);
    const clerkUserId = auth.kind === "user" ? auth.userId : null;
    const emailNormalized = normalizeEmail(email);

    const supabase = dbPublic();
    const { error } = await supabase
      .from("waitlist_signups")
      .upsert(
        {
          email,
          email_normalized: emailNormalized,
          desired_tier: tier,
          source: "pricing_modal",
          clerk_user_id: clerkUserId,
        },
        { onConflict: "email_normalized,desired_tier" },
      );

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not join the waitlist." },
      { status: 500 },
    );
  }
}
