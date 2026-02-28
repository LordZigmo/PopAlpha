import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { measureAsync } from "@/lib/perf";

export const runtime = "nodejs";

type SnapshotRow = {
  canonical_slug: string;
  printing_id: string | null;
  grade: string;
  active_listings_7d: number | null;
  median_7d: number | null;
  median_30d: number | null;
  trimmed_median_30d: number | null;
  low_30d: number | null;
  high_30d: number | null;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const printing = url.searchParams.get("printing")?.trim() ?? "";
  const grade = (url.searchParams.get("grade")?.trim() ?? "RAW").toUpperCase();
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing slug query param." }, { status: 400 });
  }

  const supabase = getServerSupabaseClient();
  let query = supabase
    .from("card_metrics")
    .select(
      "canonical_slug, printing_id, grade, active_listings_7d, median_7d, median_30d, trimmed_median_30d, low_30d, high_30d"
    )
    .eq("canonical_slug", slug)
    .eq("grade", grade)
    .limit(1);

  query = printing ? query.eq("printing_id", printing) : query.is("printing_id", null);

  const result = await measureAsync("market.snapshot.query", { slug, printing: printing || null, grade }, async () => {
    const { data, error } = await query.maybeSingle<SnapshotRow>();
    return { data, error: error?.message ?? null };
  });

  if (result.error) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    active7d: result.data?.active_listings_7d ?? 0,
    median7d: result.data?.median_7d ?? null,
    median30d: result.data?.median_30d ?? null,
    trimmedMedian30d: result.data?.trimmed_median_30d ?? null,
    low30d: result.data?.low_30d ?? null,
    high30d: result.data?.high_30d ?? null,
  });
}
