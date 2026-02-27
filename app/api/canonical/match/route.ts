import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
  variant: string | null;
};

function normalize(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function contains(haystack: string, needle: string): boolean {
  return needle.length > 0 && haystack.includes(needle);
}

function scoreRow(row: CanonicalCardRow, params: { subject: string; year: number | null; setName: string; cardNumber: string; variant: string }) {
  let score = 0;
  const rowSubject = normalize(row.subject ?? row.canonical_name);
  const rowName = normalize(row.canonical_name);
  const rowSet = normalize(row.set_name);
  const rowCardNumber = normalize(row.card_number);
  const rowVariant = normalize(row.variant);

  if (rowSubject === params.subject || rowName === params.subject) score += 5;
  else if (contains(rowSubject, params.subject) || contains(rowName, params.subject)) score += 3;

  if (params.year !== null && row.year === params.year) score += 2;
  if (params.setName && contains(rowSet, params.setName)) score += 2;
  if (params.cardNumber && rowCardNumber === params.cardNumber) score += 3;
  if (params.variant && contains(rowVariant, params.variant)) score += 1;

  return score;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const subject = normalize(url.searchParams.get("subject"));
  const yearRaw = normalize(url.searchParams.get("year"));
  const setName = normalize(url.searchParams.get("set_name"));
  const cardNumber = normalize(url.searchParams.get("card_number"));
  const variant = normalize(url.searchParams.get("variant"));
  const year = /^\d{4}$/.test(yearRaw) ? Number.parseInt(yearRaw, 10) : null;

  if (!subject) {
    return NextResponse.json({ ok: false, error: "Missing subject query param." }, { status: 400 });
  }

  const supabase = getServerSupabaseClient();
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year, card_number, language, variant")
    .or(`subject.ilike.%${subject}%,canonical_name.ilike.%${subject}%`)
    .limit(120);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as CanonicalCardRow[];
  let best: { row: CanonicalCardRow; score: number } | null = null;

  for (const row of rows) {
    const score = scoreRow(row, { subject, year, setName, cardNumber, variant });
    if (!best || score > best.score) {
      best = { row, score };
    }
  }

  if (!best || best.score < 5) {
    return NextResponse.json({ ok: true, match: null });
  }

  return NextResponse.json({
    ok: true,
    match: {
      slug: best.row.slug,
      canonical_name: best.row.canonical_name,
      score: best.score,
    },
  });
}

