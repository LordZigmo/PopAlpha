import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";

export const runtime = "nodejs";

type CardProfileRow = {
  canonical_slug: string;
  signal_label: string | null;
  verdict: string | null;
  chip: string | null;
  summary_short: string;
  summary_long: string | null;
  created_at: string;
};

function sanitizeSlug(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function GET(req: Request) {
  const slug = sanitizeSlug(new URL(req.url).searchParams.get("slug"));
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing slug query param." }, { status: 400 });
  }

  try {
    const supabase = dbPublic();
    const { data, error } = await supabase
      .from("card_profiles")
      .select("canonical_slug, signal_label, verdict, chip, summary_short, summary_long, created_at")
      .eq("canonical_slug", slug)
      .maybeSingle<CardProfileRow>();

    if (error) {
      throw new Error(`Failed reading card_profiles: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      slug,
      profile: data ?? null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, slug, error: toErrorMessage(error) }, { status: 500 });
  }
}

