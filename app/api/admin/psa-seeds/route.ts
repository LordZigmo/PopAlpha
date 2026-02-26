import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type SeedRequest = {
  cert_no?: unknown;
  notes?: unknown;
  enabled?: unknown;
};

export async function POST(req: Request) {
  const adminSecret = process.env.ADMIN_SECRET;
  const auth = req.headers.get("authorization") ?? "";

  if (!adminSecret) {
    return NextResponse.json(
      { ok: false, error: "Missing ADMIN_SECRET env var (server-only)." },
      { status: 500 }
    );
  }

  if (auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "Missing server Supabase env vars. Set SUPABASE URL + SUPABASE_SERVICE_ROLE_KEY.",
      },
      { status: 500 }
    );
  }

  let payload: SeedRequest;
  try {
    payload = (await req.json()) as SeedRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  const certNo = typeof payload.cert_no === "string" ? payload.cert_no.trim() : "";
  if (!certNo) {
    return NextResponse.json(
      { ok: false, error: "cert_no is required and must be a non-empty string." },
      { status: 400 }
    );
  }

  const notes = typeof payload.notes === "string" ? payload.notes.trim() : null;
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : true;

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data, error } = await supabase
    .from("psa_seed_certs")
    .upsert({ cert_no: certNo, notes, enabled }, { onConflict: "cert_no" })
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { ok: false, error: `Upsert psa_seed_certs failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, seed: data });
}
