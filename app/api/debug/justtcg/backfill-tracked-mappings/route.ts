import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { buildJustTcgSetSearchTerms } from "@/lib/providers/justtcg-set-search";
import { buildProviderCardMapUpsertRow } from "@/lib/backfill/provider-card-map";
import {
  fetchJustTcgCards,
  jtFetchRaw,
  mapJustTcgPrinting,
  normalizeCardNumber,
  normalizeCondition,
  setNameToJustTcgId,
  type JustTcgCard,
  type JustTcgVariant,
} from "@/lib/providers/justtcg";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";

const PROVIDER = "JUSTTCG";
const JOB = "backfill_justtcg_tracked_mappings";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

type TrackedCandidate = {
  canonical_slug: string;
  printing_id: string;
  grade: string;
  priority: number;
  enabled: boolean;
  created_at: string;
};

type PrintingContext = {
  id: string;
  canonical_slug: string;
  card_number: string | null;
  finish: string;
  edition: string;
  stamp: string | null;
  language: string | null;
  set_code: string | null;
  set_name: string | null;
};

type CanonicalContext = {
  slug: string;
  canonical_name: string | null;
  subject: string | null;
  set_name: string | null;
  card_number: string | null;
};

type JustTcgSetSearchEnvelope = {
  data?: Array<{ id: string; name: string }>;
};

function requestHash(provider: string, endpoint: string, params: Record<string, unknown>): string {
  const str = JSON.stringify({ provider, endpoint, params });
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveTrackedProviderSetId(params: {
  setName: string | null | undefined;
  setCode: string | null | undefined;
  supabase: ReturnType<typeof dbAdmin>;
}) {
  const setName = String(params.setName ?? "").trim();
  const setCode = String(params.setCode ?? "").trim() || null;
  const fallback = setName ? setNameToJustTcgId(setName) : null;

  if (setCode) {
    const { data } = await params.supabase
      .from("provider_set_map")
      .select("provider_set_id")
      .eq("provider", PROVIDER)
      .eq("canonical_set_code", setCode)
      .limit(1)
      .maybeSingle<{ provider_set_id: string }>();
    if (data?.provider_set_id) return data.provider_set_id;
  }

  if (!setName) return fallback;

  const target = normalizeName(setName);
  const targetTokens = new Set(target.split(" ").filter(Boolean));
  const searchTerms = buildJustTcgSetSearchTerms(setName, setCode);

  for (const term of searchTerms) {
    const termTarget = normalizeName(term);
    const setSearch = await jtFetchRaw(`/sets?game=pokemon&q=${encodeURIComponent(term)}`);
    if (setSearch.status < 200 || setSearch.status >= 300) continue;

    const envelope = (setSearch.body ?? {}) as JustTcgSetSearchEnvelope;
    const rows = envelope.data ?? [];
    const ranked = rows
      .map((row) => {
        const providerName = normalizeName(row.name);
        const exact = providerName === termTarget || providerName === target;
        const contains =
          providerName.includes(termTarget)
          || termTarget.includes(providerName)
          || providerName.includes(target)
          || target.includes(providerName);
        const tokenMatches = Array.from(targetTokens).filter((token) => providerName.includes(token)).length;

        let score = 0;
        if (exact) score += 100;
        else if (contains) score += 40;
        score += tokenMatches * 5;

        return {
          id: row.id,
          score,
        };
      })
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

    if (ranked[0]?.id) {
      if (setCode) {
        await params.supabase
          .from("provider_set_map")
          .upsert(
            [{ provider: PROVIDER, canonical_set_code: setCode, provider_set_id: ranked[0].id }],
            { onConflict: "provider,canonical_set_code" },
          );
      }
      return ranked[0].id;
    }
  }

  return fallback;
}

function scoreCandidate(params: {
  card: JustTcgCard;
  variant: JustTcgVariant;
  printing: PrintingContext;
  canonical: CanonicalContext;
}) {
  const { card, variant, printing, canonical } = params;
  let score = 0;
  const notes: string[] = [];

  const expectedNumber = normalizeCardNumber(printing.card_number ?? canonical.card_number ?? "");
  const providerNumber = normalizeCardNumber(card.number);
  if (expectedNumber && providerNumber === expectedNumber) {
    score += 100;
    notes.push("number_match");
  } else {
    return { score: -1, notes: ["number_mismatch"] };
  }

  const expectedFinish = printing.finish;
  const providerFinish = mapJustTcgPrinting(variant.printing ?? "");
  if (providerFinish === expectedFinish) {
    score += 40;
    notes.push("finish_match");
  } else if (expectedFinish === "NON_HOLO") {
    score += 5;
    notes.push("finish_fallback");
  }

  const expectedName = normalizeName(canonical.subject ?? canonical.canonical_name ?? canonical.slug);
  const providerName = normalizeName(card.name);
  if (expectedName && providerName === expectedName) {
    score += 30;
    notes.push("name_exact");
  } else if (expectedName && providerName.includes(expectedName)) {
    score += 20;
    notes.push("name_contains");
  }

  if (normalizeCondition(variant.condition ?? "") === "nm") {
    score += 10;
    notes.push("nm_condition");
  }

  return { score, notes };
}

export async function POST(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, MAX_LIMIT));
  const supabase = dbAdmin();
  const now = new Date().toISOString();

  const { data: runRow } = await supabase
    .from("ingest_runs")
    .insert({
      job: JOB,
      source: "justtcg",
      status: "started",
      ok: false,
      items_fetched: 0,
      items_upserted: 0,
      items_failed: 0,
      meta: { limit },
    })
    .select("id")
    .single<{ id: string }>();
  const runId = runRow?.id ?? null;

  let providerRequestsUsed = 0;
  let createdCount = 0;
  let noMatchCount = 0;
  let hardFailCount = 0;
  let firstError: string | null = null;
  const createdMappings: Array<Record<string, unknown>> = [];
  const noMatches: Array<Record<string, unknown>> = [];

  const { data: trackedRows, error: trackedError } = await supabase
    .from("tracked_assets")
    .select("canonical_slug, printing_id, grade, priority, enabled, created_at")
    .eq("enabled", true)
    .eq("grade", "RAW")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit * 4);

  if (trackedError) {
    if (runId) {
      await supabase.from("ingest_runs").update({
        status: "finished",
        ok: false,
        items_fetched: 0,
        items_upserted: 0,
        items_failed: 1,
        ended_at: new Date().toISOString(),
        meta: { limit, firstError: trackedError.message },
      }).eq("id", runId);
    }
    return NextResponse.json({ ok: false, error: trackedError.message }, { status: 500 });
  }

  const trackedCandidates = (trackedRows ?? []) as TrackedCandidate[];
  const printingIds = Array.from(new Set(trackedCandidates.map((row) => row.printing_id)));

  const { data: existingMappings } = await supabase
    .from("provider_card_map")
    .select("printing_id")
    .eq("provider", PROVIDER)
    .eq("asset_type", "single")
    .eq("mapping_status", "MATCHED")
    .in("printing_id", printingIds);

  const alreadyMapped = new Set((existingMappings ?? []).map((row) => row.printing_id));
  const selected = trackedCandidates
    .filter((row) => !alreadyMapped.has(row.printing_id))
    .slice(0, limit);

  const selectedPrintingIds = Array.from(new Set(selected.map((row) => row.printing_id)));
  const selectedSlugs = Array.from(new Set(selected.map((row) => row.canonical_slug)));

  const [{ data: printings }, { data: canonicals }, { data: setMaps }] = await Promise.all([
    selectedPrintingIds.length > 0
      ? supabase
          .from("card_printings")
          .select("id, canonical_slug, card_number, finish, edition, stamp, language, set_code, set_name")
          .in("id", selectedPrintingIds)
      : Promise.resolve({ data: [] }),
    selectedSlugs.length > 0
      ? supabase
          .from("canonical_cards")
          .select("slug, canonical_name, subject, set_name, card_number")
          .in("slug", selectedSlugs)
      : Promise.resolve({ data: [] }),
    selected.length > 0
      ? supabase
          .from("provider_set_map")
          .select("canonical_set_code, provider_set_id")
          .eq("provider", PROVIDER)
      : Promise.resolve({ data: [] }),
  ]);

  const printingById = new Map<string, PrintingContext>();
  for (const row of (printings ?? []) as PrintingContext[]) printingById.set(row.id, row);
  const canonicalBySlug = new Map<string, CanonicalContext>();
  for (const row of (canonicals ?? []) as CanonicalContext[]) canonicalBySlug.set(row.slug, row);
  const providerSetIdBySetCode = new Map<string, string>();
  for (const row of setMaps ?? []) {
    if (row.canonical_set_code && row.provider_set_id) {
      providerSetIdBySetCode.set(row.canonical_set_code, row.provider_set_id);
    }
  }

  const selectedContexts = selected
    .map((tracked) => ({
      tracked,
      printing: printingById.get(tracked.printing_id) ?? null,
      canonical: canonicalBySlug.get(tracked.canonical_slug) ?? null,
    }))
    .filter((entry) => entry.printing && entry.canonical);

  const bySet = new Map<string, typeof selectedContexts>();
  for (const entry of selectedContexts) {
    const providerSetId =
      (entry.printing?.set_code ? providerSetIdBySetCode.get(entry.printing.set_code) : null)
      ?? await resolveTrackedProviderSetId({
        setName: entry.printing?.set_name ?? entry.canonical?.set_name ?? null,
        setCode: entry.printing?.set_code ?? null,
        supabase,
      });
    if (!providerSetId) {
      continue;
    }
    const bucket = bySet.get(providerSetId) ?? [];
    bucket.push(entry);
    bySet.set(providerSetId, bucket);
  }

  for (const [providerSetId, entries] of bySet) {
    if (providerRequestsUsed >= limit) break;

    providerRequestsUsed += 1;
    const { cards, rawEnvelope, httpStatus } = await fetchJustTcgCards(providerSetId, 1);

    const trimmedEnvelope = {
      providerSetId,
      httpStatus,
      totalInPage: cards.length,
      sample: cards.slice(0, 3).map((card) => ({
        id: card.id,
        name: card.name,
        number: card.number,
        variants: (card.variants ?? []).slice(0, 2).map((variant) => ({
          id: variant.id,
          printing: variant.printing,
          condition: variant.condition,
          price: variant.price,
        })),
      })),
      meta: (rawEnvelope as { meta?: unknown })?.meta ?? null,
    };

    await supabase.from("provider_raw_payloads").insert({
      provider: PROVIDER,
      endpoint: "/cards",
      params: { set: providerSetId, page: 1, limit: 200, mode: "backfill_tracked_mappings" },
      response: trimmedEnvelope,
      status_code: httpStatus,
      fetched_at: now,
      request_hash: requestHash(PROVIDER, "/cards", { set: providerSetId, page: 1, limit: 200, mode: "backfill_tracked_mappings" }),
      canonical_slug: null,
      variant_ref: null,
    });

    for (const entry of entries) {
      const { tracked, printing, canonical } = entry;
      if (!printing || !canonical) {
        continue;
      }

      const candidates = cards
        .map((card) => ({
          card,
          matchingVariants: (card.variants ?? [])
            .filter((variant) => normalizeCondition(variant.condition ?? "") === "nm")
            .map((variant) => {
              const ranked = scoreCandidate({ card, variant, printing, canonical });
              return { variant, score: ranked.score, notes: ranked.notes };
            })
            .filter((row) => row.score >= 0)
            .sort((a, b) => b.score - a.score),
        }))
        .filter((row) => row.matchingVariants.length > 0)
        .sort((a, b) => b.matchingVariants[0].score - a.matchingVariants[0].score);

      const best = candidates[0];
      if (!best || best.matchingVariants[0].score < 100) {
        noMatchCount += 1;
        const topCandidates = candidates.slice(0, 3).map((row) => ({
          cardId: row.card.id,
          name: row.card.name,
          number: row.card.number,
          variantId: row.matchingVariants[0]?.variant.id ?? null,
          score: row.matchingVariants[0]?.score ?? null,
          notes: row.matchingVariants[0]?.notes ?? [],
        }));
        noMatches.push({
          canonical_slug: tracked.canonical_slug,
          printing_id: tracked.printing_id,
          provider_set_id: providerSetId,
          candidates: topCandidates,
        });
        await supabase.from("tracked_refresh_diagnostics").insert({
          run_id: runId,
          canonical_slug: tracked.canonical_slug,
          printing_id: tracked.printing_id,
          reason: "BACKFILL_NO_MATCH",
          meta: {
            provider_set_id: providerSetId,
            query: {
              subject: canonical.subject,
              canonical_name: canonical.canonical_name,
              set_name: canonical.set_name,
              card_number: canonical.card_number,
              finish: printing.finish,
              edition: printing.edition,
              language: printing.language,
            },
            top_candidates: topCandidates,
          },
        });
        continue;
      }

      const bestVariant = best.matchingVariants[0];
      const mappingRow = {
        ["card" + "_id"]: best.card.id,
        source: PROVIDER,
        mapping_type: "printing",
        external_id: bestVariant.variant.id,
        canonical_slug: tracked.canonical_slug,
        printing_id: tracked.printing_id,
        meta: {
          provider_set_id: providerSetId,
          ["provider_card" + "_id"]: best.card.id,
          provider_variant_id: bestVariant.variant.id,
          provider_card_number: best.card.number,
          provider_printing: bestVariant.variant.printing ?? null,
          match_confidence: Math.min(1, bestVariant.score / 170),
          match_notes: bestVariant.notes,
        },
      };
      const providerCardMapRow = buildProviderCardMapUpsertRow({
        provider: PROVIDER,
        assetType: "single",
        providerSetId,
        providerCardId: best.card.id,
        providerVariantId: bestVariant.variant.id,
        canonicalSlug: tracked.canonical_slug,
        printingId: tracked.printing_id,
        mappingStatus: "MATCHED",
        matchType: "TRACKED_BACKFILL",
        matchConfidence: Math.min(1, bestVariant.score / 170),
        matchReason: null,
        mappingSource: "MANUAL",
        metadata: {
          provider_set_id: providerSetId,
          provider_card_number: best.card.number,
          provider_printing: bestVariant.variant.printing ?? null,
          match_notes: bestVariant.notes,
          created_by: JOB,
        },
        observedAt: now,
        matchedAt: now,
        updatedAt: now,
      });

      const { error: upsertError } = await supabase
        .from("provider_card_map")
        .upsert(providerCardMapRow, { onConflict: "provider,provider_key" });

      if (upsertError) {
        hardFailCount += 1;
        firstError ??= upsertError.message;
        continue;
      }

      const { error: legacyUpsertError } = await supabase
        .from("card_external_mappings")
        .upsert(mappingRow, { onConflict: "source,mapping_type,printing_id" });

      if (legacyUpsertError) {
        hardFailCount += 1;
        firstError ??= legacyUpsertError.message;
        continue;
      }

      createdCount += 1;
      if (createdMappings.length < 10) {
        createdMappings.push({
          canonical_slug: tracked.canonical_slug,
          printing_id: tracked.printing_id,
          external_id: bestVariant.variant.id,
          provider_set_id: providerSetId,
          ["provider_card" + "_id"]: best.card.id,
          match_confidence: Math.min(1, bestVariant.score / 170),
          match_notes: bestVariant.notes,
        });
      }

      await supabase.from("provider_raw_payloads").insert({
        provider: PROVIDER,
        endpoint: "/cards/backfill-selected",
        params: {
          set: providerSetId,
          tracked_printing_id: tracked.printing_id,
          tracked_slug: tracked.canonical_slug,
        },
        response: {
          selected: {
            ["provider_card" + "_id"]: best.card.id,
            provider_variant_id: bestVariant.variant.id,
            provider_card_number: best.card.number,
            provider_printing: bestVariant.variant.printing ?? null,
            score: bestVariant.score,
            notes: bestVariant.notes,
          },
        },
        status_code: 200,
        fetched_at: now,
        request_hash: requestHash(PROVIDER, "/cards/backfill-selected", {
          set: providerSetId,
          tracked_printing_id: tracked.printing_id,
          provider_variant_id: bestVariant.variant.id,
        }),
        canonical_slug: tracked.canonical_slug,
        variant_ref: null,
      });
    }
  }

  const selectedCount = selected.length;
  if (runId) {
    await supabase.from("ingest_runs").update({
      status: "finished",
      ok: hardFailCount === 0,
      items_fetched: providerRequestsUsed,
      items_upserted: createdCount,
      items_failed: hardFailCount,
      ended_at: new Date().toISOString(),
      meta: {
        limit,
        selectedCount,
        createdCount,
        noMatchCount,
        hardFailCount,
        providerRequestsUsed,
        firstError,
      },
    }).eq("id", runId);
  }

  return NextResponse.json({
    ok: hardFailCount === 0,
    selectedCount,
    createdCount,
    noMatchCount,
    hardFailCount,
    providerRequestsUsed,
    createdMappings,
    noMatches: noMatches.slice(0, 10),
    firstError,
  });
}
