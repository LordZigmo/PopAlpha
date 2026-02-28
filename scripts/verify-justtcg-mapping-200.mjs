import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

if (!JUSTTCG_API_KEY) {
  throw new Error("Missing JUSTTCG_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = "https://api.justtcg.com/v1";
const TARGET_COUNT = 200;
const OUTPUT_DIR = path.join(process.cwd(), "scripts", "output");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "justtcg_mapping_audit_200.json");

function setNameToJustTcgId(setName) {
  return (
    setName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + "-pokemon"
  );
}

function normalizeSetNameForMatch(name) {
  return String(name ?? "")
    .replace(/^[A-Za-z]{1,4}\d*[A-Za-z]*\s*:\s*/u, "")
    .toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setNamesAreCompatible(providerSetName, candidateSetName) {
  const providerNorm = normalizeSetNameForMatch(providerSetName);
  const candidateNorm = normalizeSetNameForMatch(candidateSetName);
  if (!providerNorm || !candidateNorm) return false;
  if (providerNorm === candidateNorm) return true;

  const providerTokens = providerNorm.split(" ").filter(Boolean);
  const candidateTokens = candidateNorm.split(" ").filter(Boolean);
  const providerNoSet = providerTokens.filter((token) => token !== "set");
  const candidateNoSet = candidateTokens.filter((token) => token !== "set");
  return providerNoSet.join(" ") === candidateNoSet.join(" ");
}

function scoreSetNameMatch(justTcgName, ourName) {
  const a = normalizeSetNameForMatch(justTcgName);
  const b = normalizeSetNameForMatch(ourName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const intersection = [...aTokens].filter((t) => bTokens.has(t)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 70);
}

function normalizeCardNumber(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim().replace(/^#/, "");
  const slashMatch = trimmed.match(/^(\d+)\//);
  if (slashMatch) return String(parseInt(slashMatch[1], 10));
  if (/^\d+$/.test(trimmed)) return String(parseInt(trimmed, 10));
  return trimmed;
}

function mapJustTcgPrinting(printing) {
  const p = String(printing ?? "").toLowerCase();
  if (p.includes("reverse")) return "REVERSE_HOLO";
  if (p.includes("holo")) return "HOLO";
  return "NON_HOLO";
}

async function fetchJustTcgCards(setId, page = 1) {
  const url =
    `${BASE_URL}/cards?set=${encodeURIComponent(setId)}` +
    `&page=${page}&limit=200&priceHistoryDuration=30d`;

  const response = await fetch(url, {
    headers: { "x-api-key": JUSTTCG_API_KEY },
    cache: "no-store",
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`JustTCG ${response.status} for ${setId}: ${JSON.stringify(body).slice(0, 200)}`);
  }

  return {
    cards: Array.isArray(body?.data) ? body.data : [],
    hasMore: Boolean(body?.meta?.hasMore),
    meta: body?.meta ?? null,
  };
}

async function loadReferenceData() {
  const [{ data: printings, error: printingsError }, { data: setMap, error: setMapError }] = await Promise.all([
    supabase
      .from("card_printings")
      .select("id,canonical_slug,set_code,set_name,year,card_number,language,finish,edition,stamp")
      .eq("language", "EN")
      .not("canonical_slug", "is", null)
      .limit(50000),
    supabase
      .from("provider_set_map")
      .select("canonical_set_code,canonical_set_name,provider_set_id,confidence")
      .eq("provider", "JUSTTCG")
      .order("confidence", { ascending: false }),
  ]);

  if (printingsError) throw printingsError;
  if (setMapError) throw setMapError;

  const printingRows = (printings ?? []).map((row) => ({
    ...row,
    normalizedNumber: normalizeCardNumber(row.card_number),
  }));

  const setsByCode = new Map();
  for (const row of printingRows) {
    if (!row.set_code || !row.set_name) continue;
    if (!setsByCode.has(row.set_code)) {
      setsByCode.set(row.set_code, { setCode: row.set_code, setName: row.set_name });
    }
  }

  const providerSetQueue = [];
  const seenProviderSetIds = new Set();

  for (const row of setMap ?? []) {
    if (!row.provider_set_id || seenProviderSetIds.has(row.provider_set_id)) continue;
    seenProviderSetIds.add(row.provider_set_id);
    providerSetQueue.push({
      providerSetId: row.provider_set_id,
      canonicalSetCode: row.canonical_set_code ?? null,
      canonicalSetName: row.canonical_set_name ?? null,
      source: row.confidence === 1 ? "provider_set_map_exact" : "provider_set_map",
    });
  }

  for (const set of [...setsByCode.values()]) {
    const providerSetId = setNameToJustTcgId(set.setName);
    if (seenProviderSetIds.has(providerSetId)) continue;
    seenProviderSetIds.add(providerSetId);
    providerSetQueue.push({
      providerSetId,
      canonicalSetCode: set.setCode,
      canonicalSetName: set.setName,
      source: "derived_from_set_name",
    });
  }

  return { printingRows, canonicalSets: [...setsByCode.values()], providerSetQueue };
}

async function fetchAuditItems(providerSetQueue) {
  const items = [];
  const seenCardIds = new Set();
  const fetchLog = [];

  for (const setInfo of providerSetQueue) {
    let page = 1;
    let hasMore = true;

    while (hasMore && items.length < TARGET_COUNT) {
      const payload = await fetchJustTcgCards(setInfo.providerSetId, page);
      fetchLog.push({
        providerSetId: setInfo.providerSetId,
        page,
        fetched: payload.cards.length,
      });

      for (const card of payload.cards) {
        if (seenCardIds.has(card.id)) continue;
        seenCardIds.add(card.id);
        items.push({
          providerSetId: setInfo.providerSetId,
          canonicalSetCodeHint: setInfo.canonicalSetCode,
          canonicalSetNameHint: setInfo.canonicalSetName,
          providerSetSource: setInfo.source,
          card,
        });
        if (items.length >= TARGET_COUNT) break;
      }

      hasMore = payload.hasMore;
      page += 1;
    }

    if (items.length >= TARGET_COUNT) break;
  }

  return { items, fetchLog };
}

function chooseSetMatch(cardSetName, setHint, canonicalSets) {
  if (
    setHint?.canonicalSetCodeHint &&
    setHint?.canonicalSetNameHint &&
    (!cardSetName || setNamesAreCompatible(cardSetName, setHint.canonicalSetNameHint))
  ) {
    return {
      setCode: setHint.canonicalSetCodeHint,
      setName: setHint.canonicalSetNameHint,
      score: 100,
      source: setHint.providerSetSource,
    };
  }

  let best = null;
  for (const candidate of canonicalSets) {
    const score = scoreSetNameMatch(cardSetName, candidate.setName);
    if (!best || score > best.score) {
      best = { setCode: candidate.setCode, setName: candidate.setName, score, source: "fuzzy_set_name" };
    }
  }

  return best && best.score >= 60 ? best : null;
}

function mapCard(item, context) {
  const card = item.card;
  const cardSetName = card.set_name ?? card.set ?? "";
  const setMatch = chooseSetMatch(cardSetName, item, context.canonicalSets);

  const result = {
    external_id: card.id,
    name: card.name,
    set: cardSetName,
    number: card.number,
    candidate_matches: [],
    chosen_match: null,
    match_confidence: "none",
    failure_reason: null,
  };

  if (!setMatch) {
    result.failure_reason = "no_set_match";
    return result;
  }

  const setCandidates = context.printingsBySetCode.get(setMatch.setCode) ?? [];
  const compatibleSetCandidates = setCandidates.filter((printing) => {
    if (!cardSetName || !printing.set_name) return true;
    return setNamesAreCompatible(cardSetName, printing.set_name);
  });

  const number = normalizeCardNumber(card.number);
  const numberMatches = (compatibleSetCandidates.length > 0 ? compatibleSetCandidates : setCandidates).filter(
    (printing) => printing.normalizedNumber === number,
  );

  if (numberMatches.length === 0) {
    result.failure_reason = "no_number_match";
    return result;
  }

  result.candidate_matches = numberMatches.map((printing) => ({
    printing_id: printing.id,
    canonical_slug: printing.canonical_slug,
    finish: printing.finish,
    edition: printing.edition,
    stamp: printing.stamp,
  }));

  const canonicalSlugs = [...new Set(numberMatches.map((printing) => printing.canonical_slug))];
  if (canonicalSlugs.length > 1) {
    result.failure_reason = "ambiguous_match";
    result.match_confidence = "low";
    return result;
  }

  const variantFinishMatches = [...new Set((card.variants ?? []).map((variant) => mapJustTcgPrinting(variant.printing)))];
  const finishFiltered = variantFinishMatches.length > 0
    ? numberMatches.filter((printing) => variantFinishMatches.includes(printing.finish))
    : numberMatches;

  const uniqueCandidates = finishFiltered.length > 0 ? finishFiltered : numberMatches;

  if (uniqueCandidates.length === 1) {
    const chosen = uniqueCandidates[0];
    result.chosen_match = {
      canonical_slug: chosen.canonical_slug,
      printing_id: chosen.id,
    };
    result.match_confidence = setMatch.score >= 100 ? "high" : "medium";
    return result;
  }

  result.chosen_match = {
    canonical_slug: canonicalSlugs[0],
    printing_id: null,
  };

  const groupedByFinish = new Set(uniqueCandidates.map((printing) => printing.finish));
  if (groupedByFinish.size > 1 || uniqueCandidates.some((printing) => printing.edition !== "UNLIMITED" || printing.stamp)) {
    result.failure_reason = "no_variant_match";
    result.match_confidence = "low";
    return result;
  }

  result.failure_reason = "ambiguous_match";
  result.match_confidence = "low";
  return result;
}

function summarize(results, fetchLog) {
  const totalFetched = results.length;
  const mappedToCanonicalSlug = results.filter((row) => row.chosen_match?.canonical_slug).length;
  const mappedToPrintingId = results.filter((row) => row.chosen_match?.printing_id).length;
  const ambiguousTotal = results.filter((row) => row.failure_reason === "ambiguous_match").length;
  const unmappedTotal = results.filter((row) => row.failure_reason !== null).length;
  const mappingSuccessRate = totalFetched > 0
    ? Number(((mappedToPrintingId / totalFetched) * 100).toFixed(1))
    : 0;

  const byFailureReason = {};
  for (const row of results) {
    if (!row.failure_reason) continue;
    if (!byFailureReason[row.failure_reason]) {
      byFailureReason[row.failure_reason] = { count: 0, examples: [] };
    }
    byFailureReason[row.failure_reason].count += 1;
    if (byFailureReason[row.failure_reason].examples.length < 20) {
      byFailureReason[row.failure_reason].examples.push({
        external_id: row.external_id,
        name: row.name,
        set: row.set,
        number: row.number,
      });
    }
  }

  const bySet = {};
  for (const row of results) {
    bySet[row.set] = (bySet[row.set] ?? 0) + 1;
  }

  return {
    total_fetched: totalFetched,
    mapped_to_canonical_slug: mappedToCanonicalSlug,
    mapped_to_printing_id: mappedToPrintingId,
    unmapped_total: unmappedTotal,
    ambiguous_total: ambiguousTotal,
    mapping_success_rate: mappingSuccessRate,
    fetched_pages: fetchLog.length,
    by_set: bySet,
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { printingRows, canonicalSets, providerSetQueue } = await loadReferenceData();
  const printingsBySetCode = new Map();
  for (const row of printingRows) {
    if (!row.set_code) continue;
    const bucket = printingsBySetCode.get(row.set_code) ?? [];
    bucket.push(row);
    printingsBySetCode.set(row.set_code, bucket);
  }

  const { items, fetchLog } = await fetchAuditItems(providerSetQueue);
  const context = { printingRows, canonicalSets, printingsBySetCode };
  const results = items.map((item) => mapCard(item, context));
  const summary = summarize(results, fetchLog);

  const topFailures = Object.entries(summary.by_set)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const payload = {
    generated_at: new Date().toISOString(),
    summary,
    by_failure_reason: Object.fromEntries(
      Object.entries(
        results.reduce((acc, row) => {
          if (!row.failure_reason) return acc;
          acc[row.failure_reason] = acc[row.failure_reason] ?? { count: 0, examples: [] };
          acc[row.failure_reason].count += 1;
          if (acc[row.failure_reason].examples.length < 20) {
            acc[row.failure_reason].examples.push({
              external_id: row.external_id,
              name: row.name,
              set: row.set,
              number: row.number,
            });
          }
          return acc;
        }, {}),
      ),
    ),
    examples: results,
    fetched_sets: fetchLog,
    top_sets: topFailures,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));

  console.log(JSON.stringify({
    summary,
    top_failure_reasons: payload.by_failure_reason,
    output: OUTPUT_PATH,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
