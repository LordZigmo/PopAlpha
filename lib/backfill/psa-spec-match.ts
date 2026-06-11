/**
 * PSA SpecID → catalog matching: DB-driven runner.
 *
 * Walks psa_spec_targets, hydrates each spec's structured PSACert fields
 * (scan_psa_spec_cert_fields — description strings are lossy, the cert
 * payloads are not), resolves the PSA Brand to a canonical set
 * (psa_set_map curated rows first, deterministic derivation second),
 * matches within the set, and persists psa_spec_card_map rows.
 * High-confidence matches sync canonical_slug onto psa_spec_targets so
 * population snapshots can key by card slug.
 *
 * Trust rules (the 2026-06-10 lesson: green ≠ correct):
 *   - decisions below PSA_SPEC_MIN_AUTO_MATCH_CONFIDENCE are persisted as
 *     UNMATCHED/LOW_CONFIDENCE_MATCH_BLOCKED with the proposal in
 *     metadata — queued for a human, never silently applied;
 *   - rows with verified=true are owner-confirmed ground truth: the
 *     runner never touches them, force or not;
 *   - derived set resolutions are persisted into psa_set_map
 *     (source='DERIVED') so every brand→set assumption is visible and
 *     correctable in SQL, mirroring provider_set_map's philosophy.
 *
 * Pure decision logic lives in lib/psa/spec-match.ts (unit-tested);
 * this file is plumbing only.
 */

import { dbAdmin } from "@/lib/db/admin";
import {
  decideSpecMatch,
  parsePsaBrand,
  resolvePsaSet,
  type CanonicalSetIndexRow,
  type PsaPrintingRow,
  type PsaSetMapRow,
  type PsaSetResolution,
  type PsaSpecFields,
} from "@/lib/psa/spec-match";

const JOB = "psa_spec_match";
const SOURCE = "psa";
const DEFAULT_LIMIT = 500;
const TARGET_SCAN_CAP = 2000;
const IN_CLAUSE_CHUNK = 400;
const MIN_AUTO_MATCH_CONFIDENCE = process.env.PSA_SPEC_MIN_AUTO_MATCH_CONFIDENCE
  ? Number.parseFloat(process.env.PSA_SPEC_MIN_AUTO_MATCH_CONFIDENCE)
  : 0.9;
const UNMATCHED_RETRY_HOURS = process.env.PSA_SPEC_UNMATCHED_RETRY_HOURS
  ? Number.parseInt(process.env.PSA_SPEC_UNMATCHED_RETRY_HOURS, 10)
  : 24;
/** psa_spec_targets.priority floor applied on MATCH — the snapshot
 * cron's rotation orders by priority within equal staleness, so mapped
 * specs win official-API budget over unmapped ones. */
const MATCHED_PRIORITY_FLOOR = 10;

type TargetRow = {
  spec_id: number;
  description: string | null;
  canonical_slug: string | null;
  priority: number | null;
  fields: Record<string, unknown> | null;
  pop_heading_id: number | null;
};

type PopPageHintRow = {
  heading_id: number;
  title: string | null;
  language: string;
  canonical_set_code: string | null;
  set_confidence: number;
};

type SpecCardMapRow = {
  spec_id: number;
  canonical_slug: string | null;
  mapping_status: "MATCHED" | "UNMATCHED";
  verified: boolean;
  updated_at: string | null;
};

type SpecFieldsRow = {
  spec_id: number;
  year: string | null;
  brand: string | null;
  category: string | null;
  card_number: string | null;
  subject: string | null;
  variety: string | null;
};

type SpecCardMapWriteRow = {
  spec_id: number;
  canonical_slug: string | null;
  printing_id: string | null;
  mapping_status: "MATCHED" | "UNMATCHED";
  match_type: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  mapping_source: "PIPELINE";
  metadata: Record<string, unknown>;
  matched_at: string | null;
  updated_at: string;
};

export type PsaSpecMatchSample = {
  specId: number;
  description: string | null;
  mappingStatus: "MATCHED" | "UNMATCHED";
  canonicalSlug: string | null;
  printingId: string | null;
  matchType: string | null;
  matchConfidence: number | null;
  matchReason: string | null;
};

export type PsaSpecMatchResult = {
  ok: boolean;
  job: string;
  startedAt: string;
  endedAt: string;
  targetsScanned: number;
  skipped: { verified: number; alreadyMatched: number; recentlyUnmatched: number };
  processed: number;
  matched: number;
  unmatched: number;
  unmatchedByReason: Record<string, number>;
  slugsSynced: number;
  derivedSetMapRows: number;
  minAutoMatchConfidence: number;
  dryRun: boolean;
  firstError: string | null;
  samples: PsaSpecMatchSample[];
};

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size));
  }
  return out;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function storedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** psa_spec_targets.fields jsonb → PsaSpecFields. Written by the cert
 * harvest hook and pop-page discovery; null/garbage falls back to the
 * cert-store RPC. */
function parseStoredFields(
  specId: number,
  fields: Record<string, unknown> | null,
): PsaSpecFields | null {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const candidate: PsaSpecFields = {
    specId,
    year: storedString(fields.year),
    brand: storedString(fields.brand),
    category: storedString(fields.category),
    cardNumber: storedString(fields.cardNumber),
    subject: storedString(fields.subject),
    variety: storedString(fields.variety),
  };
  // A row with no identifying content is not usable structure.
  if (!candidate.brand && !candidate.subject && !candidate.cardNumber) return null;
  return candidate;
}

export async function runPsaSpecMatch(opts: {
  limit?: number;
  specId?: number | null;
  force?: boolean;
  dryRun?: boolean;
  /** Inline harvest-hook calls skip ingest_runs to avoid one row per scan. */
  logRun?: boolean;
} = {}): Promise<PsaSpecMatchResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;

  const skipped = { verified: 0, alreadyMatched: 0, recentlyUnmatched: 0 };
  const unmatchedByReason: Record<string, number> = {};
  const samples: PsaSpecMatchSample[] = [];
  let targetsScanned = 0;
  let processed = 0;
  let matched = 0;
  let unmatched = 0;
  let slugsSynced = 0;
  let derivedSetMapRows = 0;
  let firstError: string | null = null;

  try {
    // ── 1. Candidate targets ─────────────────────────────────────────
    let targetQuery = supabase
      .from("psa_spec_targets")
      .select("spec_id, description, canonical_slug, priority, fields, pop_heading_id")
      .order("spec_id", { ascending: true })
      .limit(TARGET_SCAN_CAP);
    if (opts.specId) targetQuery = targetQuery.eq("spec_id", opts.specId);
    const { data: targetRows, error: targetError } = await targetQuery;
    if (targetError) throw new Error(`psa_spec_targets(select): ${targetError.message}`);
    const targets = (targetRows ?? []) as TargetRow[];
    targetsScanned = targets.length;

    const existingByspec = new Map<number, SpecCardMapRow>();
    for (const ids of chunk(targets.map((row) => row.spec_id), IN_CLAUSE_CHUNK)) {
      if (ids.length === 0) continue;
      const { data, error } = await supabase
        .from("psa_spec_card_map")
        .select("spec_id, canonical_slug, mapping_status, verified, updated_at")
        .in("spec_id", ids);
      if (error) throw new Error(`psa_spec_card_map(select existing): ${error.message}`);
      for (const row of (data ?? []) as SpecCardMapRow[]) existingByspec.set(row.spec_id, row);
    }

    const retryCutoffMs = Date.now() - Math.max(1, UNMATCHED_RETRY_HOURS) * 60 * 60 * 1000;
    const candidates: TargetRow[] = [];
    for (const target of targets) {
      const existing = existingByspec.get(target.spec_id);
      if (existing?.verified) {
        skipped.verified += 1;
        continue;
      }
      if (existing && !force) {
        if (existing.mapping_status === "MATCHED") {
          skipped.alreadyMatched += 1;
          continue;
        }
        const updatedMs = parseDateMs(existing.updated_at);
        if (updatedMs !== null && updatedMs > retryCutoffMs) {
          skipped.recentlyUnmatched += 1;
          continue;
        }
      }
      candidates.push(target);
      if (candidates.length >= limit) break;
    }

    if (candidates.length > 0) {
      // ── 2. Structured fields + matching context ────────────────────
      // Targets carry their own `fields` when harvested with structure
      // (cert scans since Phase 2b, pop-page discovery always — scraped
      // specs have NO cert payload to hydrate from). The cert-store RPC
      // covers the rest.
      const fieldsBySpec = new Map<number, PsaSpecFields>();
      for (const candidate of candidates) {
        const stored = parseStoredFields(candidate.spec_id, candidate.fields);
        if (stored) fieldsBySpec.set(candidate.spec_id, stored);
      }
      const missingFieldIds = candidates
        .map((row) => row.spec_id)
        .filter((specId) => !fieldsBySpec.has(specId));
      for (const ids of chunk(missingFieldIds, IN_CLAUSE_CHUNK)) {
        const { data, error } = await supabase.rpc("scan_psa_spec_cert_fields", {
          p_spec_ids: ids,
        });
        if (error) throw new Error(`scan_psa_spec_cert_fields: ${error.message}`);
        for (const row of (data ?? []) as SpecFieldsRow[]) {
          fieldsBySpec.set(row.spec_id, {
            specId: row.spec_id,
            year: row.year,
            brand: row.brand,
            category: row.category,
            cardNumber: row.card_number,
            subject: row.subject,
            variety: row.variety,
          });
        }
      }

      // Pop-page provenance pins the set directly — discovery pages are
      // registered with a canonical_set_code, so specs found there skip
      // brand parsing entirely.
      const pageHints = new Map<number, PopPageHintRow>();
      const headingIds = [
        ...new Set(
          candidates
            .map((row) => row.pop_heading_id)
            .filter((value): value is number => typeof value === "number"),
        ),
      ];
      for (const ids of chunk(headingIds, IN_CLAUSE_CHUNK)) {
        if (ids.length === 0) continue;
        const { data, error } = await supabase
          .from("psa_pop_set_pages")
          .select("heading_id, title, language, canonical_set_code, set_confidence")
          .in("heading_id", ids);
        if (error) throw new Error(`psa_pop_set_pages(hints): ${error.message}`);
        for (const row of (data ?? []) as PopPageHintRow[]) {
          pageHints.set(row.heading_id, row);
        }
      }

      const { data: setMapRows, error: setMapError } = await supabase
        .from("psa_set_map")
        .select("psa_brand_key, canonical_set_code, canonical_set_name, language, confidence, source");
      if (setMapError) throw new Error(`psa_set_map(select): ${setMapError.message}`);
      const curatedByKey = new Map<string, PsaSetMapRow>();
      for (const row of (setMapRows ?? []) as PsaSetMapRow[]) {
        curatedByKey.set(row.psa_brand_key, row);
      }

      const { data: setIndexRows, error: setIndexError } = await supabase.rpc(
        "scan_canonical_set_index",
      );
      if (setIndexError) throw new Error(`scan_canonical_set_index: ${setIndexError.message}`);
      const setIndex = (setIndexRows ?? []) as CanonicalSetIndexRow[];

      // ── 3. Resolve sets: page hint first, then per distinct brand ──
      const resolutionByKey = new Map<string, PsaSetResolution | null>();
      const resolutionBySpec = new Map<number, PsaSetResolution | null>();
      const derivedRows: Array<Record<string, unknown>> = [];
      for (const candidate of candidates) {
        const hint = candidate.pop_heading_id !== null
          ? pageHints.get(candidate.pop_heading_id)
          : undefined;
        if (hint?.canonical_set_code) {
          resolutionBySpec.set(candidate.spec_id, {
            setCode: hint.canonical_set_code,
            setName: hint.title,
            language: hint.language,
            method: "CURATED",
            confidence: Math.min(1, Math.max(0, hint.set_confidence)),
          });
          continue;
        }

        const fields = fieldsBySpec.get(candidate.spec_id);
        if (!fields?.brand) {
          resolutionBySpec.set(candidate.spec_id, null);
          continue;
        }
        const parsed = parsePsaBrand(fields.brand);
        if (!resolutionByKey.has(parsed.key)) {
          const resolution = resolvePsaSet({ parsed, curatedByKey, setIndex });
          resolutionByKey.set(parsed.key, resolution);
          if (resolution && resolution.method !== "CURATED") {
            derivedRows.push({
              psa_brand_key: parsed.key,
              canonical_set_code: resolution.setCode,
              canonical_set_name: resolution.setName,
              language: resolution.language,
              confidence: resolution.confidence,
              source: "DERIVED",
              notes: `derived via ${resolution.method}`,
            });
          }
        }
        resolutionBySpec.set(candidate.spec_id, resolutionByKey.get(parsed.key) ?? null);
      }
      if (derivedRows.length > 0 && !dryRun) {
        const { error: derivedError } = await supabase
          .from("psa_set_map")
          .upsert(derivedRows, { onConflict: "psa_brand_key", ignoreDuplicates: true });
        if (derivedError) throw new Error(`psa_set_map(derived upsert): ${derivedError.message}`);
        derivedSetMapRows = derivedRows.length;
      } else {
        derivedSetMapRows = dryRun ? derivedRows.length : 0;
      }

      // ── 4. Printings + canonical names for resolved sets ───────────
      const neededSetCodes = [
        ...new Set(
          [...resolutionBySpec.values()]
            .filter((res): res is PsaSetResolution => res !== null)
            .map((res) => res.setCode),
        ),
      ];
      const printings: PsaPrintingRow[] = [];
      if (neededSetCodes.length > 0) {
        const pageSize = 1000;
        for (let from = 0; ; from += pageSize) {
          const { data, error } = await supabase.rpc("scan_card_printings_by_set", {
            p_set_codes: neededSetCodes,
            p_limit: pageSize,
            p_offset: from,
          });
          if (error) throw new Error(`scan_card_printings_by_set: ${error.message}`);
          const batch = (data ?? []) as PsaPrintingRow[];
          printings.push(...batch);
          if (batch.length < pageSize) break;
        }
      }

      const canonicalNamesBySlug = new Map<string, string>();
      const slugList = [...new Set(printings.map((row) => row.canonical_slug))];
      for (const slugs of chunk(slugList, IN_CLAUSE_CHUNK)) {
        if (slugs.length === 0) continue;
        const { data, error } = await supabase
          .from("canonical_cards")
          .select("slug, canonical_name")
          .in("slug", slugs);
        if (error) throw new Error(`canonical_cards(select names): ${error.message}`);
        for (const row of (data ?? []) as Array<{ slug: string; canonical_name: string }>) {
          canonicalNamesBySlug.set(row.slug, row.canonical_name);
        }
      }

      // ── 5. Decide + persist ─────────────────────────────────────────
      const nowIso = new Date().toISOString();
      const writes: SpecCardMapWriteRow[] = [];
      const slugSyncs: Array<{ specId: number; slug: string | null; priority: number }> = [];

      for (const candidate of candidates) {
        processed += 1;
        const fields = fieldsBySpec.get(candidate.spec_id) ?? null;

        let write: SpecCardMapWriteRow;
        if (!fields) {
          write = {
            spec_id: candidate.spec_id,
            canonical_slug: null,
            printing_id: null,
            mapping_status: "UNMATCHED",
            match_type: null,
            match_confidence: null,
            match_reason: "MISSING_STRUCTURED_FIELDS",
            mapping_source: "PIPELINE",
            metadata: { description: candidate.description },
            matched_at: null,
            updated_at: nowIso,
          };
        } else {
          const decision = decideSpecMatch({
            fields,
            setResolution: resolutionBySpec.get(candidate.spec_id) ?? null,
            printings,
            canonicalNamesBySlug,
          });

          if (decision.status === "MATCHED" && decision.confidence >= MIN_AUTO_MATCH_CONFIDENCE) {
            write = {
              spec_id: candidate.spec_id,
              canonical_slug: decision.canonicalSlug,
              printing_id: decision.printingId,
              mapping_status: "MATCHED",
              match_type: decision.matchType,
              match_confidence: decision.confidence,
              match_reason: null,
              mapping_source: "PIPELINE",
              metadata: decision.metadata,
              matched_at: nowIso,
              updated_at: nowIso,
            };
          } else if (decision.status === "MATCHED") {
            write = {
              spec_id: candidate.spec_id,
              canonical_slug: null,
              printing_id: null,
              mapping_status: "UNMATCHED",
              match_type: null,
              match_confidence: null,
              match_reason: "LOW_CONFIDENCE_MATCH_BLOCKED",
              mapping_source: "PIPELINE",
              metadata: {
                ...decision.metadata,
                proposedSlug: decision.canonicalSlug,
                proposedPrintingId: decision.printingId,
                proposedMatchType: decision.matchType,
                proposedConfidence: decision.confidence,
                minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
              },
              matched_at: null,
              updated_at: nowIso,
            };
          } else {
            write = {
              spec_id: candidate.spec_id,
              canonical_slug: null,
              printing_id: null,
              mapping_status: "UNMATCHED",
              match_type: null,
              match_confidence: null,
              match_reason: decision.reason,
              mapping_source: "PIPELINE",
              metadata: decision.metadata,
              matched_at: null,
              updated_at: nowIso,
            };
          }
        }

        writes.push(write);
        if (write.mapping_status === "MATCHED") {
          matched += 1;
        } else {
          unmatched += 1;
          const reason = write.match_reason ?? "UNKNOWN";
          unmatchedByReason[reason] = (unmatchedByReason[reason] ?? 0) + 1;
        }
        // Matched specs get a priority floor so the official-API
        // snapshot budget favors specs that can actually render on a
        // card page once the rotation grows past the daily budget.
        const currentPriority = candidate.priority ?? 0;
        const priorityFloor = write.mapping_status === "MATCHED"
          ? Math.max(currentPriority, MATCHED_PRIORITY_FLOOR)
          : currentPriority;
        if (
          (candidate.canonical_slug ?? null) !== write.canonical_slug
          || priorityFloor !== currentPriority
        ) {
          slugSyncs.push({
            specId: candidate.spec_id,
            slug: write.canonical_slug,
            priority: priorityFloor,
          });
        }
        if (samples.length < 25) {
          samples.push({
            specId: candidate.spec_id,
            description: candidate.description,
            mappingStatus: write.mapping_status,
            canonicalSlug: write.canonical_slug,
            printingId: write.printing_id,
            matchType: write.match_type,
            matchConfidence: write.match_confidence,
            matchReason: write.match_reason,
          });
        }
      }

      if (!dryRun && writes.length > 0) {
        for (const batch of chunk(writes, 250)) {
          const { error } = await supabase
            .from("psa_spec_card_map")
            .upsert(batch, { onConflict: "spec_id" });
          if (error) throw new Error(`psa_spec_card_map(upsert): ${error.message}`);
        }

        for (const batch of chunk(slugSyncs, 10)) {
          await Promise.all(
            batch.map(async (sync) => {
              const { error } = await supabase
                .from("psa_spec_targets")
                .update({ canonical_slug: sync.slug, priority: sync.priority })
                .eq("spec_id", sync.specId);
              if (error) {
                throw new Error(`psa_spec_targets(slug sync ${sync.specId}): ${error.message}`);
              }
              slugsSynced += 1;
            }),
          );
        }
      }
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  const result: PsaSpecMatchResult = {
    ok: firstError === null,
    job: JOB,
    startedAt,
    endedAt,
    targetsScanned,
    skipped,
    processed,
    matched,
    unmatched,
    unmatchedByReason,
    slugsSynced,
    derivedSetMapRows,
    minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
    dryRun,
    firstError,
    samples,
  };

  if (opts.logRun !== false) {
    const { error: runError } = await supabase.from("ingest_runs").insert({
      job: JOB,
      source: SOURCE,
      status: "finished",
      ok: result.ok,
      started_at: startedAt,
      ended_at: endedAt,
      items_fetched: processed,
      items_upserted: matched,
      items_failed: unmatched + (firstError ? 1 : 0),
      meta: {
        limit,
        specId: opts.specId ?? null,
        force,
        dryRun,
        targetsScanned,
        skipped,
        unmatchedByReason,
        slugsSynced,
        derivedSetMapRows,
        minAutoMatchConfidence: MIN_AUTO_MATCH_CONFIDENCE,
        firstError,
        samples,
      },
    });
    if (runError) {
      console.warn("[psa-spec-match] ingest_runs insert failed", { error: runError.message });
    }
  }

  return result;
}
