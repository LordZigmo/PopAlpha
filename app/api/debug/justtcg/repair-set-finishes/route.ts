import { NextResponse } from "next/server";

import { requireCron } from "@/lib/auth/require";
import { buildJustTcgSetSearchTerms } from "@/lib/providers/justtcg-set-search";
import {
  extractJustTcgPatternStamp,
  fetchJustTcgCardsPage,
  jtFetchRaw,
  mapJustTcgPrinting,
  normalizeCardNumber,
  normalizeMatchingCardNumber,
  setNameToJustTcgId,
  type JustTcgCard,
} from "@/lib/providers/justtcg";
import { dbAdmin } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SET_NAME = "Paldea Evolved";
const DEFAULT_SET_CODE = "sv2";
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

type JustTcgSetSearchEnvelope = {
  data?: Array<{ id: string; name: string }>;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  set_name: string | null;
  set_code: string | null;
  year: number | null;
  card_number: string | null;
  language: string | null;
  finish: string;
  finish_detail: string | null;
  edition: string;
  stamp: string | null;
  rarity: string | null;
  image_url: string | null;
  source: string | null;
  source_id: string | null;
  updated_at?: string | null;
};

type CanonicalRow = {
  slug: string;
  canonical_name: string | null;
  subject: string | null;
  card_number: string | null;
};

type FinishVariant = {
  finish: "NON_HOLO" | "HOLO" | "REVERSE_HOLO";
  variantKey: "normal" | "holofoil" | "reverseholofoil";
  stamp: string | null;
};

type ProviderCardCandidate = {
  card: JustTcgCard;
  stamp: string | null;
  baseName: string;
};

type ManualRepair = {
  cardNumber: string;
  sourceCardId: string;
  primaryFinish: FinishVariant["finish"];
  extraFinishes: FinishVariant["finish"][];
};

const MANUAL_REPAIRS = new Map<string, ManualRepair>([
  [
    "black-bolt-60-antique-cover-fossil",
    {
      cardNumber: "80",
      sourceCardId: "zsv10pt5-80",
      primaryFinish: "NON_HOLO",
      extraFinishes: ["HOLO"],
    },
  ],
]);

function normalizeName(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toStampToken(value: string) {
  return normalizeName(value).replace(/\s+/g, "_").toUpperCase();
}

function parsePatternStamp(...values: Array<string | null | undefined>): string | null {
  return extractJustTcgPatternStamp(...values);
}

function stripPatternSuffix(name: string): string {
  return name
    .replace(/\s*\([^()]+\)\s*$/u, "")
    .replace(/\s+(?:[A-Za-z]+\s+Ball|[A-Za-z]+(?:\s+[A-Za-z]+)*\s+Pattern)\s*$/iu, "")
    .trim();
}

function namesMatch(expectedName: string, providerName: string) {
  return providerName === expectedName || providerName.includes(expectedName) || expectedName.includes(providerName);
}

function stampPriority(stamp: string | null) {
  if (!stamp) return 0;
  if (stamp === "POKE_BALL_PATTERN") return 1;
  if (stamp === "ENERGY_SYMBOL_PATTERN") return 2;
  if (stamp === "MASTER_BALL_PATTERN") return 3;
  return 10;
}

function finishPriority(finish: FinishVariant["finish"]) {
  if (finish === "NON_HOLO") return 1;
  if (finish === "HOLO") return 2;
  return 3;
}

function toVariantKey(finish: FinishVariant["finish"]): FinishVariant["variantKey"] {
  if (finish === "NON_HOLO") return "normal";
  if (finish === "HOLO") return "holofoil";
  return "reverseholofoil";
}

function distinctFinishVariants(card: JustTcgCard): FinishVariant[] {
  const seen = new Set<string>();
  const variants: FinishVariant[] = [];
  for (const variant of card.variants ?? []) {
    const language = (variant.language ?? "English").trim().toLowerCase();
    if (language !== "english") continue;
    const finish = mapJustTcgPrinting(variant.printing ?? "");
    if (finish !== "NON_HOLO" && finish !== "HOLO" && finish !== "REVERSE_HOLO") continue;
    const stamp = parsePatternStamp(variant.printing, card.name);
    const key = `${finish}:${stamp ?? "BASE"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ finish, variantKey: toVariantKey(finish), stamp });
  }
  return variants.sort((a, b) =>
    stampPriority(a.stamp) - stampPriority(b.stamp)
    || finishPriority(a.finish) - finishPriority(b.finish)
  );
}

function buildSourceId(cardId: string, variant: FinishVariant) {
  return `${cardId}:${variant.finish}:${variant.stamp ?? "BASE"}:UNLIMITED:${variant.variantKey}`;
}

function buildCandidateSummary(candidate: ProviderCardCandidate) {
  return {
    id: candidate.card.id,
    name: candidate.card.name,
    number: candidate.card.number,
    stamp: candidate.stamp,
  };
}

async function ensurePrintingRow(
  row: Record<string, unknown>,
) {
  const attemptedTarget = {
    canonical_slug: row.canonical_slug ?? null,
    set_code: row.set_code ?? null,
    card_number: row.card_number ?? null,
    language: row.language ?? null,
    finish: row.finish ?? null,
    edition: row.edition ?? null,
    stamp: row.stamp ?? null,
    finish_detail: row.finish_detail ?? null,
    source_id: row.source_id ?? null,
  };
  const supabase = dbAdmin();
  const source = String(row.source ?? "");
  const sourceId = String(row.source_id ?? "");
  const { data: existing, error: selectError } = await supabase
    .from("card_printings")
    .select("id")
    .eq("source", source)
    .eq("source_id", sourceId)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (selectError) return { ok: false, error: selectError.message, attemptedTarget };

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("card_printings")
      .update(row)
      .eq("id", existing.id);
    return updateError ? { ok: false, error: updateError.message, attemptedTarget } : { ok: true, inserted: false };
  }

  const { error: insertError } = await supabase
    .from("card_printings")
    .insert(row);
  if (!insertError) return { ok: true, inserted: true };

  if (insertError.message.includes("card_printings_unique_printing_idx")) {
    const { data: conflictingRow, error: conflictError } = await supabase
      .from("card_printings")
      .select("id, canonical_slug")
      .eq("set_code", attemptedTarget.set_code)
      .eq("card_number", attemptedTarget.card_number)
      .eq("language", attemptedTarget.language)
      .eq("finish", attemptedTarget.finish)
      .eq("edition", attemptedTarget.edition)
      .is("stamp", attemptedTarget.stamp)
      .is("finish_detail", attemptedTarget.finish_detail)
      .limit(1)
      .maybeSingle<{ id: string; canonical_slug: string }>();

    if (conflictError) return { ok: false, error: conflictError.message, attemptedTarget };
    if (!conflictingRow) return { ok: false, error: insertError.message, attemptedTarget };
    if (conflictingRow.canonical_slug !== attemptedTarget.canonical_slug) {
      return {
        ok: false,
        error: `Conflicting printing belongs to ${conflictingRow.canonical_slug}, not ${attemptedTarget.canonical_slug}.`,
        attemptedTarget,
      };
    }

    const { error: mergeError } = await supabase
      .from("card_printings")
      .update(row)
      .eq("id", conflictingRow.id);
    return mergeError ? { ok: false, error: mergeError.message, attemptedTarget } : { ok: true, inserted: false, merged: true };
  }

  return { ok: false, error: insertError.message, attemptedTarget };
}

async function fetchSetCards(providerSetId: string) {
  const cards: JustTcgCard[] = [];
  let page = 1;
  let expectedTotal: number | null = null;
  const seenCardIds = new Set<string>();

  while (page <= MAX_PAGES) {
    const result = await fetchJustTcgCardsPage(providerSetId, page, {
      limit: PAGE_LIMIT,
      priceHistoryDuration: "30d",
      includeNullPrices: true,
    });
    if (result.httpStatus < 200 || result.httpStatus >= 300) {
      throw new Error(`JustTCG fetch failed: HTTP ${result.httpStatus}`);
    }

    const meta = (
      result.rawEnvelope
      && typeof result.rawEnvelope === "object"
      && "meta" in result.rawEnvelope
      && result.rawEnvelope.meta
      && typeof result.rawEnvelope.meta === "object"
    ) ? (result.rawEnvelope.meta as { total?: number; hasMore?: boolean }) : null;

    if (typeof meta?.total === "number" && Number.isFinite(meta.total) && meta.total > 0) {
      expectedTotal = meta.total;
    }

    let pageNewCardCount = 0;
    for (const card of result.cards) {
      if (!seenCardIds.has(card.id)) {
        seenCardIds.add(card.id);
        pageNewCardCount += 1;
        cards.push(card);
      }
    }

    const hitExpectedTotal = expectedTotal !== null && seenCardIds.size >= expectedTotal;
    const shortOrEmptyPage = result.cards.length < PAGE_LIMIT;
    const repeatedPage = result.cards.length > 0 && pageNewCardCount === 0;
    if (!result.hasMore || hitExpectedTotal || shortOrEmptyPage || repeatedPage) {
      break;
    }
    page += 1;
  }

  return cards;
}

async function fetchCardsByNumber(providerSetId: string, rawNumber: string | null | undefined) {
  const terms = Array.from(new Set([
    String(rawNumber ?? "").trim().replace(/^#/, ""),
    normalizeCardNumber(rawNumber ?? ""),
    normalizeMatchingCardNumber(rawNumber ?? ""),
  ].filter(Boolean)));

  for (const term of terms) {
    const result = await fetchJustTcgCardsPage(providerSetId, 1, {
      limit: PAGE_LIMIT,
      priceHistoryDuration: "30d",
      offset: 0,
      includeNullPrices: true,
      number: term,
    });
    if (result.httpStatus >= 200 && result.httpStatus < 300 && result.cards.length > 0) {
      return result.cards;
    }
  }

  return [] as JustTcgCard[];
}

async function resolveProviderSetId(params: { setName: string; setCode: string | null; providerSetIdOverride: string | null }) {
  const { setName, setCode, providerSetIdOverride } = params;
  if (providerSetIdOverride) return providerSetIdOverride;

  const supabase = dbAdmin();
  const canonicalFallbackSetId = setNameToJustTcgId(setName);
  const searchTerms = buildJustTcgSetSearchTerms(setName, setCode);
  const target = normalizeName(setName);
  const targetTokens = new Set(target.split(" ").filter(Boolean));
  const localLooksPromo = /\bpromo\b/i.test(setName);
  const localLooksEnergy = /\benerg(?:y|ies)\b/i.test(setName);

  for (const term of searchTerms) {
    const termTarget = normalizeName(term);
    const setSearch = await jtFetchRaw(`/sets?game=pokemon&q=${encodeURIComponent(term)}`);
    if (setSearch.status < 200 || setSearch.status >= 300) continue;
    const envelope = (setSearch.body ?? {}) as JustTcgSetSearchEnvelope;
    const rows = envelope.data ?? [];
    const ranked = rows
      .map((row) => {
        const providerName = normalizeName(row.name);
        const providerId = normalizeName(row.id.replace(/-/g, " "));
        const exact = providerName === termTarget || providerName === target;
        const contains =
          providerName.includes(termTarget)
          || termTarget.includes(providerName)
          || providerName.includes(target)
          || target.includes(providerName);
        const providerLooksPromo = /\bpromo\b/.test(providerName) || /\bpromo\b/.test(providerId);
        const providerLooksEnergy = /\benerg(?:y|ies)\b/.test(providerName) || /\benerg(?:y|ies)\b/.test(providerId);
        const tokenMatches = Array.from(targetTokens).filter((token) => providerName.includes(token)).length;
        let score = 0;
        if (exact) score += 100;
        else if (contains) score += 40;
        score += tokenMatches * 5;
        if (!localLooksPromo && providerLooksPromo) score -= 50;
        if (localLooksPromo && !providerLooksPromo) score -= 20;
        if (!localLooksEnergy && providerLooksEnergy) score -= 25;
        if (localLooksEnergy && !providerLooksEnergy) score -= 10;
        return {
          id: row.id,
          score,
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (ranked.length > 0) {
      if (setCode) {
        await supabase
          .from("provider_set_map")
          .upsert(
            [{ provider: "JUSTTCG", canonical_set_code: setCode, provider_set_id: ranked[0].id }],
            { onConflict: "provider,canonical_set_code" },
          );
      }
      return ranked[0].id;
    }
  }

  if (setCode) {
    const { data } = await supabase
      .from("provider_set_map")
      .select("provider_set_id")
      .eq("provider", "JUSTTCG")
      .eq("canonical_set_code", setCode)
      .limit(1)
      .maybeSingle<{ provider_set_id: string }>();
    if (data?.provider_set_id) return data.provider_set_id;
  }

  return canonicalFallbackSetId;
}

export async function POST(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();
  const url = new URL(req.url);
  const targetSetCode = (url.searchParams.get("setCode") ?? DEFAULT_SET_CODE).trim() || null;
  const targetSetName = (url.searchParams.get("setName") ?? DEFAULT_SET_NAME).trim() || DEFAULT_SET_NAME;
  const providerSetIdOverride = (url.searchParams.get("providerSetId") ?? "").trim() || null;
  const providerSetId = await resolveProviderSetId({
    setName: targetSetName,
    setCode: targetSetCode,
    providerSetIdOverride,
  });

  const { data: printingRows, error: printingError } = await supabase
    .from("card_printings")
    .select("id, canonical_slug, set_name, set_code, year, card_number, language, finish, finish_detail, edition, stamp, rarity, image_url, source, source_id, updated_at")
    .eq("language", "EN")
    .eq("set_code", targetSetCode)
    .ilike("set_name", targetSetName)
    .eq("finish", "UNKNOWN")
    .order("card_number", { ascending: true });

  if (printingError) {
    return NextResponse.json({ ok: false, error: printingError.message }, { status: 500 });
  }

  const unknownPrintings = (printingRows ?? []) as PrintingRow[];
  if (unknownPrintings.length === 0) {
    return NextResponse.json({
      ok: true,
      set: targetSetName,
      setCode: targetSetCode,
      providerSetId,
      selected: 0,
      updatedInPlace: 0,
      insertedVariants: 0,
      skipped: 0,
      note: "No UNKNOWN EN printings remain for this set.",
    });
  }

  const slugs = Array.from(new Set(unknownPrintings.map((row) => row.canonical_slug)));
  const { data: canonicalRows, error: canonicalError } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, card_number")
    .in("slug", slugs);

  if (canonicalError) {
    return NextResponse.json({ ok: false, error: canonicalError.message }, { status: 500 });
  }

  const canonicalBySlug = new Map<string, CanonicalRow>();
  for (const row of ((canonicalRows ?? []) as CanonicalRow[])) {
    canonicalBySlug.set(row.slug, row);
  }

  const cards = await fetchSetCards(providerSetId);
  const cardsByNumber = new Map<string, JustTcgCard[]>();
  const cardsByBaseName = new Map<string, JustTcgCard[]>();
  for (const card of cards) {
    const key = normalizeMatchingCardNumber(card.number);
    const bucket = cardsByNumber.get(key) ?? [];
    bucket.push(card);
    cardsByNumber.set(key, bucket);
    const baseName = normalizeName(stripPatternSuffix(card.name));
    const byName = cardsByBaseName.get(baseName) ?? [];
    byName.push(card);
    cardsByBaseName.set(baseName, byName);
  }

  let updatedInPlace = 0;
  let insertedVariants = 0;
  let skipped = 0;
  const updatedSamples: Array<Record<string, unknown>> = [];
  const skippedSamples: Array<Record<string, unknown>> = [];

  for (const printing of unknownPrintings) {
    const canonical = canonicalBySlug.get(printing.canonical_slug);
    if (!canonical) {
      skipped += 1;
      if (skippedSamples.length < 25) skippedSamples.push({ canonical_slug: printing.canonical_slug, printing_id: printing.id, reason: "missing_canonical" });
      continue;
    }

    const downstreamRefCounts = await Promise.all([
      supabase.from("market_latest").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
      supabase.from("price_snapshots").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
      supabase.from("variant_metrics").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
      supabase.from("card_external_mappings").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
      supabase.from("provider_ingests").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
    ]);
    const hasDownstreamRefs = downstreamRefCounts.some((entry) => (entry.count ?? 0) > 0);

    const expectedNumber = normalizeMatchingCardNumber(printing.card_number ?? "");
    const candidateCards = expectedNumber ? cardsByNumber.get(expectedNumber) ?? [] : [];
    const expectedName = normalizeName(canonical.subject ?? canonical.canonical_name ?? printing.canonical_slug);
    let matchingCards = candidateCards
      .map((card) => ({
        card,
        stamp: parsePatternStamp(card.name),
        baseName: normalizeName(stripPatternSuffix(card.name)),
      }))
      .filter((candidate) => namesMatch(expectedName, candidate.baseName));

    if (matchingCards.length === 0 && candidateCards.length === 1) {
      const only = candidateCards[0];
      matchingCards = [{
        card: only,
        stamp: parsePatternStamp(only.name),
        baseName: normalizeName(stripPatternSuffix(only.name)),
      }];
    }

    if (matchingCards.length === 0 && expectedNumber) {
      const targetedCards = await fetchCardsByNumber(providerSetId, printing.card_number);
      const targetedMatches = targetedCards
        .map((card) => ({
          card,
          stamp: parsePatternStamp(card.name),
          baseName: normalizeName(stripPatternSuffix(card.name)),
        }))
        .filter((candidate) => namesMatch(expectedName, candidate.baseName));

      if (targetedMatches.length > 0) {
        matchingCards = targetedMatches;
      } else if (targetedCards.length === 1) {
        const only = targetedCards[0];
        matchingCards = [{
          card: only,
          stamp: parsePatternStamp(only.name),
          baseName: normalizeName(stripPatternSuffix(only.name)),
        }];
      }
    }

    if (matchingCards.length === 0) {
      const nameOnlyCards = (cardsByBaseName.get(expectedName) ?? []).map((card) => ({
        card,
        stamp: parsePatternStamp(card.name),
        baseName: normalizeName(stripPatternSuffix(card.name)),
      }));
      if (nameOnlyCards.length === 1) {
        matchingCards = nameOnlyCards;
      }
    }

    const baseCandidates = matchingCards.filter((candidate) => candidate.stamp === null);
    const exactNumberCandidates = matchingCards.filter(
      (candidate) => normalizeMatchingCardNumber(candidate.card.number) === expectedNumber,
    );
    const exactNumberBaseCandidates = exactNumberCandidates.filter((candidate) => candidate.stamp === null);
    const exactNumberStampedCandidates = exactNumberCandidates
      .filter((candidate) => candidate.stamp !== null)
      .sort((left, right) =>
        stampPriority(left.stamp) - stampPriority(right.stamp)
        || String(left.stamp ?? "").localeCompare(String(right.stamp ?? ""))
        || left.card.id.localeCompare(right.card.id),
      );
    const primaryCandidate =
      exactNumberBaseCandidates.length === 1 ? exactNumberBaseCandidates[0]
        : exactNumberCandidates.length === 1 ? exactNumberCandidates[0]
          : exactNumberBaseCandidates.length === 0 && exactNumberStampedCandidates.length > 0 ? exactNumberStampedCandidates[0]
          : baseCandidates.length === 1 ? baseCandidates[0]
            : matchingCards.length === 1 ? matchingCards[0]
          : null;
    const manualRepair = !primaryCandidate && matchingCards.length === 0
      ? MANUAL_REPAIRS.get(printing.canonical_slug) ?? null
      : null;

    if (!primaryCandidate && !manualRepair) {
      skipped += 1;
      if (skippedSamples.length < 25) {
        skippedSamples.push({
          canonical_slug: printing.canonical_slug,
          printing_id: printing.id,
          reason: matchingCards.length === 0 ? "no_provider_card_match" : "multiple_provider_cards",
          card_number: expectedNumber || null,
          provider_candidates: matchingCards.slice(0, 5).map(buildCandidateSummary),
        });
      }
      continue;
    }

    const supplementalCandidates = primaryCandidate
      ? matchingCards
          .filter((candidate) => candidate.card.id !== primaryCandidate.card.id && candidate.stamp !== null)
          .sort((left, right) =>
            stampPriority(left.stamp) - stampPriority(right.stamp)
            || left.card.id.localeCompare(right.card.id),
          )
      : [];

    const primaryCard = primaryCandidate?.card ?? null;
    const providerCardNumber = primaryCard ? normalizeMatchingCardNumber(primaryCard.number) : "";
    const resolvedCardNumber = manualRepair?.cardNumber || providerCardNumber || printing.card_number;
    const finishVariants = manualRepair
      ? [
          { finish: manualRepair.primaryFinish, variantKey: toVariantKey(manualRepair.primaryFinish), stamp: null },
          ...manualRepair.extraFinishes.map((finish) => ({ finish, variantKey: toVariantKey(finish), stamp: null })),
        ]
      : distinctFinishVariants(primaryCard!);
    if (finishVariants.length === 0) {
      skipped += 1;
      if (skippedSamples.length < 25) {
        skippedSamples.push({ canonical_slug: printing.canonical_slug, printing_id: printing.id, reason: "no_provider_finishes", provider_card_id: primaryCard?.id ?? null });
      }
      continue;
    }

    const primary = finishVariants[0];
    const extraRows = finishVariants.slice(1).map((variant) => ({
      canonical_slug: printing.canonical_slug,
      set_name: printing.set_name,
      set_code: printing.set_code,
      year: printing.year,
      card_number: printing.card_number,
      language: printing.language,
      finish: variant.finish,
      finish_detail: printing.finish_detail,
      edition: "UNLIMITED",
      stamp: variant.stamp ?? printing.stamp,
      rarity: printing.rarity,
      image_url: printing.image_url,
      source: printing.source ?? "pokemon-tcg-data",
      source_id: buildSourceId(manualRepair?.sourceCardId ?? primaryCard!.id, variant),
      updated_at: new Date().toISOString(),
    }));

    for (const supplemental of supplementalCandidates) {
      const supplementalVariants = distinctFinishVariants(supplemental.card);
      for (const variant of supplementalVariants) {
        extraRows.push({
          canonical_slug: printing.canonical_slug,
          set_name: printing.set_name,
          set_code: printing.set_code,
          year: printing.year,
          card_number: resolvedCardNumber,
          language: printing.language,
          finish: variant.finish,
          finish_detail: printing.finish_detail,
          edition: "UNLIMITED",
          stamp: variant.stamp ?? supplemental.stamp,
          rarity: printing.rarity,
          image_url: printing.image_url,
          source: printing.source ?? "pokemon-tcg-data",
          source_id: buildSourceId(supplemental.card.id, variant),
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (extraRows.length > 0) {
      let extraFailed = false;
      for (const row of extraRows) {
        const ensured = await ensurePrintingRow(row);
        if (!ensured.ok) {
          extraFailed = true;
          skipped += 1;
          if (skippedSamples.length < 25) {
            skippedSamples.push({
              canonical_slug: printing.canonical_slug,
              printing_id: printing.id,
              reason: "insert_failed",
              error: ensured.error,
              attempted_target: ensured.attemptedTarget ?? null,
            });
          }
          break;
        }
        if (ensured.inserted) insertedVariants += 1;
      }
      if (extraFailed) {
        continue;
      }
    }

    const baseUpdate = {
      canonical_slug: printing.canonical_slug,
      set_name: printing.set_name,
      set_code: printing.set_code,
      year: printing.year,
      card_number: resolvedCardNumber,
      language: printing.language,
      finish: primary.finish,
      finish_detail: printing.finish_detail,
      edition: "UNLIMITED",
      stamp: primary.stamp ?? printing.stamp,
      rarity: printing.rarity,
      image_url: printing.image_url,
      source: printing.source ?? "pokemon-tcg-data",
      source_id: buildSourceId(manualRepair?.sourceCardId ?? primaryCard!.id, primary),
      updated_at: new Date().toISOString(),
    };

    const attemptedBaseTarget = {
      canonical_slug: baseUpdate.canonical_slug,
      set_code: baseUpdate.set_code,
      card_number: baseUpdate.card_number,
      language: baseUpdate.language,
      finish: baseUpdate.finish,
      edition: baseUpdate.edition,
      stamp: baseUpdate.stamp,
      finish_detail: baseUpdate.finish_detail,
      source_id: baseUpdate.source_id,
    };

    if (resolvedCardNumber && resolvedCardNumber !== canonical.card_number) {
      const { error: canonicalUpdateError } = await supabase
        .from("canonical_cards")
        .update({ card_number: resolvedCardNumber })
        .eq("slug", printing.canonical_slug);
      if (canonicalUpdateError) {
        skipped += 1;
        if (skippedSamples.length < 25) {
          skippedSamples.push({
            canonical_slug: printing.canonical_slug,
            printing_id: printing.id,
            reason: "canonical_update_failed",
            error: canonicalUpdateError.message,
          });
        }
        continue;
      }
      canonical.card_number = resolvedCardNumber;
    }

    const { error: updateError } = await supabase
      .from("card_printings")
      .update(baseUpdate)
      .eq("id", printing.id);
    if (updateError) {
      if (updateError.message.includes("card_printings_unique_printing_idx")) {
        if (hasDownstreamRefs) {
          skipped += 1;
          if (skippedSamples.length < 25) {
            skippedSamples.push({
              canonical_slug: printing.canonical_slug,
              printing_id: printing.id,
              reason: "downstream_refs_conflict_requires_merge",
              attempted_target: attemptedBaseTarget,
            });
          }
          continue;
        }

        const { data: conflictingRow, error: conflictLookupError } = await supabase
          .from("card_printings")
          .select("id, canonical_slug")
          .eq("set_code", String(baseUpdate.set_code ?? ""))
          .eq("card_number", String(baseUpdate.card_number ?? ""))
          .eq("language", String(baseUpdate.language ?? ""))
          .eq("finish", String(baseUpdate.finish ?? ""))
          .eq("edition", String(baseUpdate.edition ?? ""))
          .is("stamp", baseUpdate.stamp ?? null)
          .is("finish_detail", baseUpdate.finish_detail ?? null)
          .limit(1)
          .maybeSingle<{ id: string; canonical_slug: string }>();

        if (!conflictLookupError && conflictingRow?.id && conflictingRow.canonical_slug === printing.canonical_slug) {
          const { error: mergeError } = await supabase
            .from("card_printings")
            .update(baseUpdate)
            .eq("id", conflictingRow.id);

          if (!mergeError) {
            const { error: deleteError } = await supabase
              .from("card_printings")
              .delete()
              .eq("id", printing.id);

            if (!deleteError) {
              updatedInPlace += 1;
              if (updatedSamples.length < 25) {
                updatedSamples.push({
                  canonical_slug: printing.canonical_slug,
                  printing_id: printing.id,
                  merged_into_printing_id: conflictingRow.id,
                  primary_finish: primary.finish,
                  provider_card_id: primaryCard?.id ?? null,
                  resolved_card_number: resolvedCardNumber,
                  manual_repair: Boolean(manualRepair),
                  supplemental_pattern_cards: supplementalCandidates.map((candidate) => ({
                    id: candidate.card.id,
                    stamp: candidate.stamp,
                  })),
                });
              }
              continue;
            }
          }
        }
      }

      skipped += 1;
      if (skippedSamples.length < 25) {
        skippedSamples.push({
          canonical_slug: printing.canonical_slug,
          printing_id: printing.id,
          reason: "update_failed",
          error: updateError.message,
          attempted_target: attemptedBaseTarget,
        });
      }
      continue;
    }
    updatedInPlace += 1;

    if (updatedSamples.length < 25) {
      updatedSamples.push({
        canonical_slug: printing.canonical_slug,
        printing_id: printing.id,
        primary_finish: primary.finish,
        provider_card_id: primaryCard?.id ?? null,
        resolved_card_number: resolvedCardNumber,
        manual_repair: Boolean(manualRepair),
        supplemental_pattern_cards: supplementalCandidates.map((candidate) => ({
          id: candidate.card.id,
          stamp: candidate.stamp,
        })),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    set: targetSetName,
    setCode: targetSetCode,
    providerSetId,
    selected: unknownPrintings.length,
    updatedInPlace,
    insertedVariants,
    skipped,
    updatedSamples,
    skippedSamples,
  });
}
