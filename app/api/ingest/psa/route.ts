import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";

  if (!cronSecret) {
    return NextResponse.json(
      { ok: false, error: "Missing CRON_SECRET env var" },
      { status: 500 }
    );
  }

  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // ✅ Accept either naming convention
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing Supabase URL env var. Set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL in Vercel.",
      },
      { status: 500 }
    );
  }

  if (!serviceKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "Missing SUPABASE_SERVICE_ROLE_KEY env var in Vercel (server-only).",
      },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // 1️⃣ Create ingest run record
  const { data: run, error: runError } = await supabase
    .from("ingest_runs")
    .insert({ source: "psa", status: "started" })
    .select()
    .single();

  if (runError) {
    return NextResponse.json(
      { ok: false, error: `Insert ingest_runs failed: ${runError.message}` },
      { status: 500 }
    );
  }

  // 2️⃣ Mark success (stub for now)
  const { error: updError } = await supabase
    .from("ingest_runs")
    .update({ status: "success", ended_at: new Date().toISOString() })
    .eq("id", run.id);

  if (updError) {
    return NextResponse.json(
      { ok: false, error: `Update ingest_runs failed: ${updError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "PSA ingest recorded successfully",
    run_id: run.id,
  });
}