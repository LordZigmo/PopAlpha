import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type CardProfileRow = {
  card_slug: string;
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
    const supabase = getServerSupabaseClient();
    const { data, error } = await supabase
      .from("card_profiles")
      .select("card_slug, summary_short, summary_long, created_at")
      .eq("card_slug", slug)
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

