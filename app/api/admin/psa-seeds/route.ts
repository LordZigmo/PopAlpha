import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getRequiredEnv, getServerConfigErrorMessage } from "@/lib/env";

export const runtime = "nodejs";

type SeedRequest = {
  cert_no?: unknown;
  notes?: unknown;
  enabled?: unknown;
};

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";

  let adminSecret: string;
  try {
    adminSecret = getRequiredEnv("ADMIN_SECRET");
  } catch {
    return NextResponse.json(
      { ok: false, error: "Missing ADMIN_SECRET env var (server-only)." },
      { status: 500 }
    );
  }

  if (auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
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

  let supabase;
  try {
    supabase = getServerSupabaseClient();
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getServerConfigErrorMessage(error),
      },
      { status: 500 }
    );
  }

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
