import { NextResponse } from "next/server";
import { getCertificate } from "@/lib/psa/client";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getRequiredEnv } from "@/lib/env";

export const runtime = "nodejs";

type IngestCounters = {
  itemsFetched: number;
  itemsUpserted: number;
  itemsFailed: number;
  firstError: string | null;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
