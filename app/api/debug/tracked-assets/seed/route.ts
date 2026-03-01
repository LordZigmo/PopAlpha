import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const STARTER_SLUGS: Array<{ slug: string; priority: number }> = [
  { slug: "base-4-charizard", priority: 1 },
  { slug: "base-2-blastoise", priority: 5 },
  { slug: "base-15-venusaur", priority: 5 },
  { slug: "base-58-pikachu", priority: 10 },
  { slug: "jungle-1-clefable", priority: 20 },
  { slug: "fossil-2-articuno", priority: 20 },
  { slug: "team-rocket-4-dark-charizard", priority: 15 },
];

export async function POST(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();
  const slugs = STARTER_SLUGS.map((entry) => entry.slug);

  const { data: printings, error } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, finish, edition, stamp")
    .in("canonical_slug", slugs)
    .order("canonical_slug", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const printingBySlug = new Map<string, { id: string; canonical_slug: string; finish: string; edition: string; stamp: string | null }[]>();
  for (const row of printings ?? []) {
    const bucket = printingBySlug.get(row.canonical_slug) ?? [];
    bucket.push(row);
    printingBySlug.set(row.canonical_slug, bucket);
  }

  const rowsToInsert: Array<Record<string, unknown>> = [];
  const seeded: Array<{ canonical_slug: string; printing_id: string; priority: number }> = [];
  let missing = 0;

  for (const entry of STARTER_SLUGS) {
    const candidates = printingBySlug.get(entry.slug) ?? [];
    const chosen =
      candidates.find((row) => row.finish === "HOLO") ??
      candidates.find((row) => row.finish === "NON_HOLO") ??
      candidates[0] ??
      null;
    if (!chosen) {
      missing += 1;
      continue;
    }
    rowsToInsert.push({
      canonical_slug: chosen.canonical_slug,
      printing_id: chosen.id,
      grade: "RAW",
      priority: entry.priority,
      enabled: true,
    });
    seeded.push({ canonical_slug: chosen.canonical_slug, printing_id: chosen.id, priority: entry.priority });
  }

  let inserted = 0;
  if (rowsToInsert.length > 0) {
    const { data: upserted, error: upsertError } = await supabase
      .from("tracked_assets")
      .upsert(rowsToInsert, { onConflict: "canonical_slug,printing_id,grade" })
      .select("canonical_slug");

    if (upsertError) {
      return NextResponse.json({ ok: false, error: upsertError.message }, { status: 500 });
    }
    inserted = upserted?.length ?? 0;
  }

  return NextResponse.json({
    ok: true,
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
    inserted,
    missing,
    seeded,
  });
}

