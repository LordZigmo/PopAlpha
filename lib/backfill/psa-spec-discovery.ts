/**
 * PSA SpecID discovery runner (Population Tables Phase 2b).
 *
 * Walks the psa_pop_set_pages registry (owner-seeded rows pointing at
 * PSA pop-report set pages), fetches each page's spec rows via
 * Pop/GetSetItems (lib/psa/pop-scrape.ts), and:
 *
 *   1. upserts every spec into psa_spec_targets (source='pop_scrape')
 *      with structured `fields` + `pop_heading_id` — scraped specs have
 *      no cert payload, so what the page gave us is what the matcher
 *      gets;
 *   2. captures the row's grade distribution as a same-day
 *      psa_spec_pop_snapshots row (source='pop_scrape') — one page fetch
 *      snapshots the whole set with zero official-API spend;
 *   3. kicks the spec matcher so new specs land matched-or-queued, not
 *      silently unmapped.
 *
 * Runs from either the cron route (app/api/cron/discover-psa-specs) or
 * the owner-run script (scripts/discover-psa-specs.mjs) — the script
 * path exists because PSA fronts www.psacard.com with Cloudflare and
 * datacenter egress may be challenged; a residential run validates
 * mechanics before any schedule is considered.
 */

import { dbAdmin } from "@/lib/db/admin";
import { fetchPopSetItems, type PopSetRow } from "@/lib/psa/pop-scrape";
import { runPsaSpecMatch, type PsaSpecMatchResult } from "@/lib/backfill/psa-spec-match";

const JOB = "psa_spec_discovery";
const SOURCE = "psa";
const DEFAULT_PAGE_LIMIT = 3;
const TARGET_UPSERT_BATCH = 250;

type PopSetPageRow = {
  heading_id: number;
  category_id: number;
  title: string;
  year: string | null;
  language: string;
  canonical_set_code: string | null;
  set_confidence: number;
  active: boolean;
  last_scraped_on: string | null;
};

export type PsaSpecDiscoveryPageSummary = {
  headingId: number;
  title: string;
  rows: number;
  skippedRows: number;
  recordsTotal: number | null;
  newSpecs: number;
  snapshotsWritten: number;
  error: string | null;
};

export type PsaSpecDiscoveryResult = {
  ok: boolean;
  job: string;
  startedAt: string;
  endedAt: string;
  pagesAttempted: number;
  pagesSucceeded: number;
  specsSeen: number;
  newSpecs: number;
  snapshotsWritten: number;
  dryRun: boolean;
  pages: PsaSpecDiscoveryPageSummary[];
  matchResult: PsaSpecMatchResult | null;
  firstError: string | null;
};

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size));
  }
  return out;
}

function buildDescription(page: PopSetPageRow, row: PopSetRow): string {
  return [page.title, row.cardNumber, row.subject, row.variety]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export async function runPsaSpecDiscovery(opts: {
  /** Restrict to one registered page (must exist in psa_pop_set_pages). */
  headingId?: number | null;
  /** Pages walked per run when no headingId is given. */
  pageLimit?: number;
  dryRun?: boolean;
  /** Skip the pop-snapshot capture (targets only). */
  snapshot?: boolean;
  /** Skip the post-discovery match kick. */
  match?: boolean;
  fetchImpl?: typeof fetch;
  logRun?: boolean;
} = {}): Promise<PsaSpecDiscoveryResult> {
  const supabase = dbAdmin();
  const startedAt = new Date().toISOString();
  const todayUtc = startedAt.slice(0, 10);
  const dryRun = opts.dryRun === true;
  const captureSnapshots = opts.snapshot !== false;
  const pageLimit = Math.max(1, Math.floor(opts.pageLimit ?? DEFAULT_PAGE_LIMIT));

  const pages: PsaSpecDiscoveryPageSummary[] = [];
  let specsSeen = 0;
  let newSpecs = 0;
  let snapshotsWritten = 0;
  let pagesSucceeded = 0;
  let matchResult: PsaSpecMatchResult | null = null;
  let firstError: string | null = null;

  try {
    let pageQuery = supabase
      .from("psa_pop_set_pages")
      .select(
        "heading_id, category_id, title, year, language, canonical_set_code, set_confidence, active, last_scraped_on",
      );
    if (opts.headingId) {
      pageQuery = pageQuery.eq("heading_id", opts.headingId);
    } else {
      pageQuery = pageQuery
        .eq("active", true)
        .or(`last_scraped_on.is.null,last_scraped_on.lt.${todayUtc}`)
        .order("last_scraped_on", { ascending: true, nullsFirst: true })
        .order("heading_id", { ascending: true })
        .limit(pageLimit);
    }
    const { data: pageRows, error: pageError } = await pageQuery;
    if (pageError) throw new Error(`psa_pop_set_pages(select): ${pageError.message}`);
    const targets = (pageRows ?? []) as PopSetPageRow[];
    if (opts.headingId && targets.length === 0) {
      throw new Error(
        `headingId ${opts.headingId} is not registered in psa_pop_set_pages — insert the registry row first`,
      );
    }

    for (const page of targets) {
      const summary: PsaSpecDiscoveryPageSummary = {
        headingId: page.heading_id,
        title: page.title,
        rows: 0,
        skippedRows: 0,
        recordsTotal: null,
        newSpecs: 0,
        snapshotsWritten: 0,
        error: null,
      };
      pages.push(summary);

      try {
        const fetched = await fetchPopSetItems({
          headingId: page.heading_id,
          categoryId: page.category_id,
          fetchImpl: opts.fetchImpl,
        });
        summary.rows = fetched.rows.length;
        summary.skippedRows = fetched.skippedRows;
        summary.recordsTotal = fetched.recordsTotal;
        specsSeen += fetched.rows.length;

        if (!dryRun && fetched.rows.length > 0) {
          for (const batch of chunk(fetched.rows, TARGET_UPSERT_BATCH)) {
            const { data: inserted, error: upsertError } = await supabase
              .from("psa_spec_targets")
              .upsert(
                batch.map((row) => ({
                  spec_id: row.specId,
                  description: buildDescription(page, row),
                  source: "pop_scrape",
                  pop_heading_id: page.heading_id,
                  fields: {
                    year: page.year,
                    brand: page.title,
                    category: "TCG Cards",
                    cardNumber: row.cardNumber,
                    subject: row.subject,
                    variety: row.variety,
                  },
                })),
                { onConflict: "spec_id", ignoreDuplicates: true },
              )
              .select("spec_id");
            if (upsertError) {
              throw new Error(`psa_spec_targets(upsert): ${upsertError.message}`);
            }
            summary.newSpecs += (inserted ?? []).length;
          }
          newSpecs += summary.newSpecs;

          if (captureSnapshots) {
            const snapshotRows = fetched.rows
              .filter((row) => Object.keys(row.gradeCounts).length > 0)
              .map((row) => ({
                spec_id: row.specId,
                captured_on: todayUtc,
                description: buildDescription(page, row),
                total: row.total,
                grade_counts: row.gradeCounts,
                raw: row.raw,
                source: "pop_scrape",
              }));
            for (const batch of chunk(snapshotRows, TARGET_UPSERT_BATCH)) {
              const { error: snapshotError } = await supabase
                .from("psa_spec_pop_snapshots")
                .upsert(batch, { onConflict: "spec_id,captured_on" });
              if (snapshotError) {
                throw new Error(`psa_spec_pop_snapshots(upsert): ${snapshotError.message}`);
              }
              summary.snapshotsWritten += batch.length;
            }
            snapshotsWritten += summary.snapshotsWritten;

            const { error: markError } = await supabase
              .from("psa_spec_targets")
              .update({ last_snapshot_on: todayUtc })
              .in("spec_id", snapshotRows.map((row) => row.spec_id));
            if (markError) {
              throw new Error(`psa_spec_targets(mark snapshot): ${markError.message}`);
            }
          }

          const { error: pageMarkError } = await supabase
            .from("psa_pop_set_pages")
            .update({ last_scraped_on: todayUtc, last_spec_count: fetched.rows.length })
            .eq("heading_id", page.heading_id);
          if (pageMarkError) {
            throw new Error(`psa_pop_set_pages(mark): ${pageMarkError.message}`);
          }
        }

        pagesSucceeded += 1;
      } catch (error) {
        summary.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        if (!firstError) firstError = summary.error;
      }
    }

    if (!dryRun && opts.match !== false && newSpecs > 0) {
      matchResult = await runPsaSpecMatch({ limit: Math.max(newSpecs, 500), logRun: false });
    }
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  // Page-level failures surface per page; the run as a whole fails only
  // when EVERY attempted page failed (Cloudflare block signature) or the
  // plumbing threw.
  const allPagesFailed = pages.length > 0 && pagesSucceeded === 0;
  const result: PsaSpecDiscoveryResult = {
    ok: !allPagesFailed && (pages.length > 0 || !firstError),
    job: JOB,
    startedAt,
    endedAt,
    pagesAttempted: pages.length,
    pagesSucceeded,
    specsSeen,
    newSpecs,
    snapshotsWritten,
    dryRun,
    pages,
    matchResult,
    firstError,
  };

  if (opts.logRun !== false) {
    const { error: runError } = await supabase.from("ingest_runs").insert({
      job: JOB,
      source: SOURCE,
      status: "finished",
      ok: result.ok,
      started_at: startedAt,
      ended_at: endedAt,
      items_fetched: specsSeen,
      items_upserted: newSpecs + snapshotsWritten,
      items_failed: pages.filter((page) => page.error).length,
      meta: {
        pageLimit,
        headingId: opts.headingId ?? null,
        dryRun,
        captureSnapshots,
        pages,
        matchSummary: matchResult
          ? {
              processed: matchResult.processed,
              matched: matchResult.matched,
              unmatched: matchResult.unmatched,
              unmatchedByReason: matchResult.unmatchedByReason,
            }
          : null,
        firstError,
      },
    });
    if (runError) {
      console.warn("[psa-spec-discovery] ingest_runs insert failed", { error: runError.message });
    }
  }

  return result;
}
