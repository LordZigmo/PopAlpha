import { NextResponse } from "next/server";

import { authorizeCronRequest } from "@/lib/cronAuth";
import {
  fetchJustTcgCardsPage,
  jtFetchRaw,
  normalizeCardNumber,
  normalizeMatchingCardNumber,
  setNameToJustTcgId,
  type JustTcgCard,
} from "@/lib/providers/justtcg";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 25;
const PROBE_LIMIT = 50;

type JustTcgSetSearchEnvelope = {
  data?: Array<{ id: string; name: string }>;
};

type PrecheckStatus =
  | "VIABLE"
  | "LIKELY_WRONG_PROVIDER_SET"
  | "LOW_OVERLAP"
  | "FULL_PROVIDER_MISS"
  | "PROVIDER_FETCH_FAILED";

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

async function resolveProviderSetId(setName: string, setCode: string | null) {
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

function classifyProbe(params: {
  setName: string;
  providerSetId: string;
  cards: JustTcgCard[];
  overlapCount: number;
  fetchFailed: boolean;
}): { status: PrecheckStatus; note: string } {
  const { setName, providerSetId, cards, overlapCount, fetchFailed } = params;
  if (fetchFailed) {
    return {
      status: "PROVIDER_FETCH_FAILED",
      note: "JustTCG probe request failed.",
    };
  }
  if (cards.length === 0) {
    return {
      status: "FULL_PROVIDER_MISS",
      note: "First provider page returned 0 cards.",
    };
  }

  const normalizedSetName = normalizeName(setName);
  const providerLooksPromo = providerSetId.includes("promo");
  const localLooksPromo = normalizedSetName.includes("promo");
  if (providerLooksPromo && !localLooksPromo) {
    return {
      status: "LIKELY_WRONG_PROVIDER_SET",
      note: "Resolved provider set id looks like a promo set for a non-promo local set.",
    };
  }

  if (overlapCount === 0) {
    return {
      status: "LOW_OVERLAP",
      note: "Provider probe returned cards, but none of the sampled local card numbers were present on the first page.",
    };
  }

  return {
    status: "VIABLE",
    note: "Provider returned cards and sampled local card numbers overlap the first page.",
  };
}

export async function GET(req: Request) {
  const auth = authorizeCronRequest(req, { allowDeprecatedQuerySecret: true });
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? "10") || 10, MAX_LIMIT));

  const supabase = getServerSupabaseClient();
  const { data: unknownRows, error } = await supabase
    .from("card_printings")
    .select("set_name,set_code,card_number")
    .eq("language", "EN")
    .eq("finish", "UNKNOWN")
    .limit(20000);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const grouped = new Map<
    string,
    { setName: string; setCode: string | null; unknownCount: number; sampleNumbers: string[] }
  >();

  for (const row of unknownRows ?? []) {
    const setName = String(row.set_name ?? "");
    const setCode = row.set_code ? String(row.set_code) : null;
    if (!setName) continue;
    const key = `${setName}||${setCode ?? ""}`;
    const existing = grouped.get(key) ?? {
      setName,
      setCode,
      unknownCount: 0,
      sampleNumbers: [],
    };
    existing.unknownCount += 1;
    const normalizedNumber = normalizeMatchingCardNumber(row.card_number ? String(row.card_number) : "");
    if (
      normalizedNumber
      && existing.sampleNumbers.length < 10
      && !existing.sampleNumbers.includes(normalizedNumber)
    ) {
      existing.sampleNumbers.push(normalizedNumber);
    }
    grouped.set(key, existing);
  }

  const targets = [...grouped.values()]
    .sort((a, b) => b.unknownCount - a.unknownCount || a.setName.localeCompare(b.setName))
    .slice(0, limit);

  const rows = [];
  for (const target of targets) {
    const providerSetId = await resolveProviderSetId(target.setName, target.setCode);
    let cards: JustTcgCard[] = [];
    let httpStatus: number | null = null;
    let fetchFailed = false;

    try {
      const result = await fetchJustTcgCardsPage(providerSetId, 1, {
        limit: PROBE_LIMIT,
        priceHistoryDuration: "30d",
        offset: 0,
        includeNullPrices: true,
      });
      cards = result.cards;
      httpStatus = result.httpStatus;
      fetchFailed = result.httpStatus < 200 || result.httpStatus >= 300;
    } catch {
      fetchFailed = true;
    }

    const providerNumbers = new Set(cards.map((card) => normalizeMatchingCardNumber(card.number)));
    const overlapCount = target.sampleNumbers.filter((value) => providerNumbers.has(value)).length;
    const classification = classifyProbe({
      setName: target.setName,
      providerSetId,
      cards,
      overlapCount,
      fetchFailed,
    });

    rows.push({
      setName: target.setName,
      setCode: target.setCode,
      unknownCount: target.unknownCount,
      providerSetId,
      probeCardCount: cards.length,
      probeHttpStatus: httpStatus,
      sampledLocalNumbers: target.sampleNumbers,
      overlapCount,
      status: classification.status,
      note: classification.note,
      sampleProviderCards: cards.slice(0, 5).map((card) => ({
        id: card.id,
        name: card.name,
        number: card.number,
      })),
    });
  }

  const statusCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    limit,
    totalUnknownRowsScanned: unknownRows?.length ?? 0,
    statusCounts,
    rows,
    deprecatedQueryAuth: auth.deprecatedQueryAuth,
  });
}
