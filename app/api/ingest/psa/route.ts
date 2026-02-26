import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Missing CRON_SECRET env var" },
      { status: 500 }
    );
  }

  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1️⃣ Create ingest run record
  const { data: run, error: runError } = await supabase
    .from("ingest_runs")
    .insert({
      source: "psa",
      status: "started",
    })
    .select()
    .single();

  if (runError) {
    return NextResponse.json(
      { ok: false, error: runError.message },
      { status: 500 }
    );
  }

  try {
    // 🔜 This is where PSA API logic will go later

    // 2️⃣ Mark success
    await supabase
      .from("ingest_runs")
      .update({
        status: "success",
        ended_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    return NextResponse.json({
      ok: true,
      message: "PSA ingest recorded successfully",
    });
  } catch (err: any) {
    await supabase
      .from("ingest_runs")
      .update({
        status: "failed",
        ended_at: new Date().toISOString(),
        notes: err?.message ?? "unknown error",
      })
      .eq("id", run.id);

    return NextResponse.json(
      { ok: false, error: "PSA ingest failed" },
      { status: 500 }
    );
  }
}