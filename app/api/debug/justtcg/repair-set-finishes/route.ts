import { NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/cronAuth";
import {
  fetchJustTcgCardsPage,
  jtFetchRaw,
  mapJustTcgPrinting,
  normalizeCardNumber,
  normalizeMatchingCardNumber,
  setNameToJustTcgId,
  type JustTcgCard,
} from "@/lib/providers/justtcg";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

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

function buildSetSearchTerms(setName: string) {
  const terms = new Set<string>();
  const trimmed = setName.trim();
  if (trimmed) terms.add(trimmed);
  const andExpanded = trimmed.replace(/&/g, " and ").replace(/\s+/g, " ").trim();
  if (andExpanded) terms.add(andExpanded);
  const punctuationCollapsed = trimmed
    .replace(/&/g, " ")
    .replace(/[—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (punctuationCollapsed) terms.add(punctuationCollapsed);
  const punctuationRemoved = trimmed
    .replace(/[&—–-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (punctuationRemoved) terms.add(punctuationRemoved);

  const promoExpanded = andExpanded
    .replace(/^DP\b/i, "Diamond and Pearl")
    .replace(/^BW\b/i, "Black and White")
    .replace(/^SWSH\b/i, "Sword and Shield")
    .replace(/^SM\b/i, "Sun and Moon")
    .replace(/^SVP\b/i, "Scarlet and Violet")
    .replace(/^XY\b/i, "XY")
    .replace(/\bBlack Star Promos\b/i, "Promos")
    .replace(/\s+/g, " ")
    .trim();
  if (promoExpanded) terms.add(promoExpanded);
  if (/^Wizards Black Star Promos$/i.test(trimmed)) terms.add("WoTC Promo");
  if (/^HS[—–-]/i.test(trimmed)) terms.add(trimmed.replace(/^HS[—–-]\s*/i, "").trim());
  if (/^HeartGold\s*&\s*SoulSilver$/i.test(trimmed)) terms.add("HeartGold SoulSilver");

  return Array.from(terms);
}

function toStampToken(value: string) {
  return normalizeName(value).replace(/\s+/g, "_").toUpperCase();
}

function parsePatternStamp(name: string): string | null {
  const parentheticalMatch = name.match(/\(([^()]+)\)\s*$/u);
  if (parentheticalMatch?.[1]) {
    const parenthetical = normalizeName(parentheticalMatch[1]);
    if (parenthetical === "poke ball") return "POKE_BALL_PATTERN";
    if (parenthetical === "master ball") return "MASTER_BALL_PATTERN";
    if (parenthetical === "energy symbol pattern") return "ENERGY_SYMBOL_PATTERN";
    return parenthetical ? parenthetical.replace(/\s+/g, "_").toUpperCase() : null;
  }
  const normalized = normalizeName(name);
  if (normalized.includes("master ball")) return "MASTER_BALL_PATTERN";
  if (normalized.includes("poke ball")) return "POKE_BALL_PATTERN";
  if (normalized.includes("energy symbol pattern")) return "ENERGY_SYMBOL_PATTERN";
  return null;
}

function stripPatternSuffix(name: string): string {
  return name
    .replace(/\s*\([^()]+\)\s*$/u, "")
    .replace(/\s+(?:Poke Ball|Master Ball|Energy Symbol Pattern)\s*$/iu, "")
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
    if (seen.has(finish)) continue;
    seen.add(finish);
    variants.push({ finish, variantKey: toVariantKey(finish) });
  }
  return variants.sort((a, b) => finishPriority(a.finish) - finishPriority(b.finish));
}

function buildSourceId(cardId: string, variant: FinishVariant) {
  return `${cardId}:${variant.finish}:UNLIMITED:${variant.variantKey}`;
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
  const supabase = getServerSupabaseClient();
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
  return insertError ? { ok: false, error: insertError.message, attemptedTarget } : { ok: true, inserted: true };
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

  const supabase = getServerSupabaseClient();
  const canonicalFallbackSetId = setNameToJustTcgId(setName);
  const searchTerms = buildSetSearchTerms(setName);
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
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();
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
      deprecatedQueryAuth: auth.deprecatedQueryAuth,
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

    const existingSignalsCount = await Promise.all([
      supabase.from("market_latest").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
      supabase.from("variant_metrics").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
      supabase.from("card_external_mappings").select("printing_id", { count: "exact", head: true }).eq("printing_id", printing.id),
    ]);
    const hasDownstreamRefs = existingSignalsCount.some((entry) => (entry.count ?? 0) > 0);
    if (hasDownstreamRefs) {
      skipped += 1;
      if (skippedSamples.length < 25) skippedSamples.push({ canonical_slug: printing.canonical_slug, printing_id: printing.id, reason: "downstream_refs_exist" });
      continue;
    }

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
    const primaryCandidate =
      baseCandidates.length === 1 ? baseCandidates[0]
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
          { finish: manualRepair.primaryFinish, variantKey: toVariantKey(manualRepair.primaryFinish) },
          ...manualRepair.extraFinishes.map((finish) => ({ finish, variantKey: toVariantKey(finish) })),
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
      stamp: printing.stamp,
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
          stamp: supplemental.stamp,
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
      stamp: printing.stamp,
      rarity: printing.rarity,
      image_url: printing.image_url,
      source: printing.source ?? "pokemon-tcg-data",
      source_id: buildSourceId(manualRepair?.sourceCardId ?? primaryCard!.id, primary),
      updated_at: new Date().toISOString(),
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
      skipped += 1;
      if (skippedSamples.length < 25) {
        skippedSamples.push({
          canonical_slug: printing.canonical_slug,
          printing_id: printing.id,
          reason: "update_failed",
          error: updateError.message,
          attempted_target: {
            canonical_slug: baseUpdate.canonical_slug,
            set_code: baseUpdate.set_code,
            card_number: baseUpdate.card_number,
            language: baseUpdate.language,
            finish: baseUpdate.finish,
            edition: baseUpdate.edition,
            stamp: baseUpdate.stamp,
            finish_detail: baseUpdate.finish_detail,
            source_id: baseUpdate.source_id,
          },
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
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
  });
}
