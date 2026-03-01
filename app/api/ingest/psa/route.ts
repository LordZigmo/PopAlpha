import { NextResponse } from "next/server";
import { getCertificate } from "@/lib/psa/client";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getRequiredEnv } from "@/lib/env";

export const runtime = "nodejs";

type IngestCounters = {
  itemsFetched: number;
  itemsUpserted: number;
  itemsFailed: number;
  gradedRowsUpserted: number;
  firstError: string | null;
};

type CanonicalCandidateRow = {
  slug: string;
  canonical_name: string;
  subject: string | null;
  set_name: string | null;
  year: number | null;
};

type PrintingCandidateRow = {
  id: string;
  finish: string;
  edition: string;
  stamp: string | null;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gradeBucketFromPsaGrade(raw: string | null | undefined): "LE_7" | "G8" | "G9" | "G10" | null {
  const match = String(raw ?? "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const grade = Number.parseFloat(match[1]);
  if (!Number.isFinite(grade)) return null;
  if (grade >= 10) return "G10";
  if (grade >= 9) return "G9";
  if (grade >= 8) return "G8";
  return "LE_7";
}

function scoreCanonicalCandidate(candidate: CanonicalCandidateRow, parsed: {
  subject: string | null;
  set_name: string | null;
  year: number | null;
}): number {
  const wantedSubject = normalizeText(parsed.subject);
  const wantedSet = normalizeText(parsed.set_name);
  const candidateName = normalizeText(candidate.canonical_name);
  const candidateSubject = normalizeText(candidate.subject);
  const candidateSet = normalizeText(candidate.set_name);

  let score = 0;
  if (wantedSubject && (candidateName === wantedSubject || candidateSubject === wantedSubject)) score += 100;
  else if (wantedSubject && (candidateName.includes(wantedSubject) || candidateSubject.includes(wantedSubject))) score += 60;

  if (wantedSet && candidateSet === wantedSet) score += 80;
  else if (wantedSet && candidateSet && (candidateSet.includes(wantedSet) || wantedSet.includes(candidateSet))) score += 40;

  if (parsed.year !== null && candidate.year === parsed.year) score += 20;
  return score;
}

function scorePrintingCandidate(printing: PrintingCandidateRow, varietyText: string): number {
  let score = 0;
  if (varietyText.includes("shadowless")) {
    score += printing.stamp?.toUpperCase() === "SHADOWLESS" ? 80 : -10;
  }
  if (varietyText.includes("1st") || varietyText.includes("first edition")) {
    score += printing.edition === "FIRST_EDITION" ? 50 : -10;
  }
  if (varietyText.includes("non holo") || varietyText.includes("nonholo")) {
    score += printing.finish === "NON_HOLO" ? 30 : -5;
  } else if (varietyText.includes("holo")) {
    score += printing.finish === "HOLO" ? 30 : -5;
  }
  return score;
}

async function resolvePsaPrinting(
  supabase: ReturnType<typeof getServerSupabaseClient>,
  parsed: {
    subject: string | null;
    set_name: string | null;
    year: number | null;
    variety: string | null;
  },
): Promise<{ canonical_slug: string; printing_id: string } | null> {
  const subjectQuery = parsed.subject?.trim();
  if (!subjectQuery) return null;

  let query = supabase
    .from("canonical_cards")
    .select("slug, canonical_name, subject, set_name, year")
    .or(`canonical_name.ilike.%${subjectQuery}%,subject.ilike.%${subjectQuery}%`)
    .limit(25);

  if (parsed.year !== null) query = query.eq("year", parsed.year);
  if (parsed.set_name) query = query.ilike("set_name", `%${parsed.set_name}%`);

  const { data: candidates, error } = await query;
  if (error) throw new Error(`canonical_cards: ${error.message}`);

  const canonical = ((candidates ?? []) as CanonicalCandidateRow[])
    .map((row) => ({ row, score: scoreCanonicalCandidate(row, parsed) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.row.slug.localeCompare(b.row.slug))[0]?.row;

  if (!canonical) return null;

  const { data: printingRows, error: printingError } = await supabase
    .from("card_printings")
    .select("id, finish, edition, stamp")
    .eq("canonical_slug", canonical.slug);

  if (printingError) throw new Error(`card_printings: ${printingError.message}`);

  const typedPrintings = (printingRows ?? []) as PrintingCandidateRow[];
  if (typedPrintings.length === 0) return null;

  const varietyText = normalizeText(parsed.variety);
  const printing = [...typedPrintings].sort((a, b) => {
    const scoreDelta = scorePrintingCandidate(b, varietyText) - scorePrintingCandidate(a, varietyText);
    if (scoreDelta !== 0) return scoreDelta;
    return a.id.localeCompare(b.id);
  })[0];

  if (!printing) return null;
  return {
    canonical_slug: canonical.slug,
    printing_id: printing.id,
  };
}

export async function POST(req: Request) {
  let cronSecret: string;
  try {
    cronSecret = getRequiredEnv("CRON_SECRET");
  } catch {
    return NextResponse.json({ ok: false, error: "Missing CRON_SECRET env var" }, { status: 500 });
  }

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let supabase;
  try {
    supabase = getServerSupabaseClient();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Server configuration error: missing Supabase server environment variables. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      },
      { status: 500 }
    );
  }

  const counters: IngestCounters = {
    itemsFetched: 0,
    itemsUpserted: 0,
    itemsFailed: 0,
    gradedRowsUpserted: 0,
    firstError: null,
  };

  const { data: run, error: runError } = await supabase
    .from("ingest_runs")
    .insert({ source: "psa", job: "psa_ingest", status: "started" })
    .select()
    .single();

  if (runError) {
    return NextResponse.json(
      { ok: false, error: `Insert ingest_runs failed: ${runError.message}` },
      { status: 500 }
    );
  }

  try {
    if (!process.env.PSA_ACCESS_TOKEN) {
      throw new Error("Missing PSA_ACCESS_TOKEN env var (server-only).");
    }

    const { data: seeds, error: seedsError } = await supabase
      .from("psa_seed_certs")
      .select("cert_no")
      .eq("enabled", true)
      .limit(20);

    if (seedsError) {
      throw new Error(`Failed loading psa_seed_certs: ${seedsError.message}`);
    }

    for (const seed of seeds ?? []) {
      try {
        const { parsed, raw } = await getCertificate(seed.cert_no);
        counters.itemsFetched += 1;

        const { error: upsertError } = await supabase.from("psa_certificates").upsert(
          {
            cert_no: parsed.cert_no,
            grade: parsed.grade,
            label: parsed.label,
            year: parsed.year,
            set_name: parsed.set_name,
            subject: parsed.subject,
            variety: parsed.variety,
            image_url: parsed.image_url,
            last_seen_at: new Date().toISOString(),
            raw_payload: raw,
          },
          { onConflict: "cert_no" }
        );

        if (upsertError) {
          throw new Error(`Upsert psa_certificates failed for ${seed.cert_no}: ${upsertError.message}`);
        }

        counters.itemsUpserted += 1;

        const gradeBucket = gradeBucketFromPsaGrade(parsed.grade);
        if (gradeBucket) {
          const resolved = await resolvePsaPrinting(supabase, parsed);
          if (resolved) {
            const { error: gradedError } = await supabase.from("variant_metrics").upsert(
              {
                canonical_slug: resolved.canonical_slug,
                printing_id: resolved.printing_id,
                variant_ref: resolved.printing_id,
                provider: "PSA",
                grade: gradeBucket,
                provider_as_of_ts: new Date().toISOString(),
              },
              { onConflict: "canonical_slug,variant_ref,provider,grade" }
            );

            if (gradedError) {
              throw new Error(`Upsert variant_metrics failed for ${seed.cert_no}: ${gradedError.message}`);
            }

            counters.gradedRowsUpserted += 1;
          }
        }
      } catch (itemError) {
        counters.itemsFailed += 1;
        if (!counters.firstError) counters.firstError = toErrorMessage(itemError);
      }
    }

    const attempted = (seeds ?? []).length;
    const allFailed = attempted > 0 && counters.itemsFailed === attempted;

    const finalStatus = allFailed ? "failed" : "success";

    const { error: updateError } = await supabase
      .from("ingest_runs")
      .update({
        status: finalStatus,
        ended_at: new Date().toISOString(),
        items_fetched: counters.itemsFetched,
        items_upserted: counters.itemsUpserted,
        items_failed: counters.itemsFailed,
        error_text: counters.firstError,
      })
      .eq("id", run.id);

    if (updateError) {
      return NextResponse.json(
        { ok: false, error: `Update ingest_runs failed: ${updateError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: finalStatus === "success",
      run_id: run.id,
      status: finalStatus,
      items_fetched: counters.itemsFetched,
      items_upserted: counters.itemsUpserted,
      items_failed: counters.itemsFailed,
      graded_rows_upserted: counters.gradedRowsUpserted,
      error_text: counters.firstError,
    });
  } catch (fatalError) {
    const errorMessage = toErrorMessage(fatalError);

    await supabase
      .from("ingest_runs")
      .update({
        status: "failed",
        ended_at: new Date().toISOString(),
        items_fetched: counters.itemsFetched,
        items_upserted: counters.itemsUpserted,
        items_failed: counters.itemsFailed,
        error_text: errorMessage,
      })
      .eq("id", run.id);

    return NextResponse.json({ ok: false, error: errorMessage, run_id: run.id }, { status: 500 });
  }
}
