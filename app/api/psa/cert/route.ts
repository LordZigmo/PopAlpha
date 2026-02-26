import { NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import { getCertificate, type CertificateResponse } from "@/lib/psa/client";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getServerConfigErrorMessage } from "@/lib/env";

export const runtime = "nodejs";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CachedCertRow = {
  cert: string;
  data: CertificateResponse;
  fetched_at: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sanitizeCert(cert: string | null): string {
  return (cert ?? "").trim();
}

async function logLookup(params: {
  supabase: SupabaseClient;
  cert: string;
  cacheHit: boolean;
  status: "success" | "error";
  errorMessage: string | null;
}) {
  await params.supabase.from("psa_cert_lookup_logs").insert({
    cert: params.cert,
    cache_hit: params.cacheHit,
    status: params.status,
    error_message: params.errorMessage,
  });
}

export async function GET(req: Request) {
  const cert = sanitizeCert(new URL(req.url).searchParams.get("cert"));

  if (!cert) {
    return NextResponse.json(
      { ok: false, error: "Missing cert query param. Example: /api/psa/cert?cert=12345678" },
      { status: 400 }
    );
  }

  let supabase: SupabaseClient;
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

  try {
    const { data: cachedRow, error: cacheReadError } = await supabase
      .from("psa_cert_cache")
      .select("cert, data, fetched_at")
      .eq("cert", cert)
      .maybeSingle<CachedCertRow>();

    if (cacheReadError) {
      throw new Error(`Failed reading psa_cert_cache: ${cacheReadError.message}`);
    }

    if (cachedRow) {
      const ageMs = Date.now() - new Date(cachedRow.fetched_at).getTime();
      const isFresh = Number.isFinite(ageMs) && ageMs <= CACHE_TTL_MS;

      if (isFresh) {
        await logLookup({
          supabase,
          cert,
          cacheHit: true,
          status: "success",
          errorMessage: null,
        });

        return NextResponse.json({
          ok: true,
          cert,
          cache_hit: true,
          fetched_at: cachedRow.fetched_at,
          source: "cache",
          data: cachedRow.data,
        });
      }
    }

    const freshData = await getCertificate(cert);
    const fetchedAt = new Date().toISOString();

    const { error: upsertError } = await supabase.from("psa_cert_cache").upsert(
      {
        cert,
        data: freshData,
        fetched_at: fetchedAt,
      },
      { onConflict: "cert" }
    );

    if (upsertError) {
      throw new Error(`Failed upserting psa_cert_cache: ${upsertError.message}`);
    }

    await logLookup({
      supabase,
      cert,
      cacheHit: false,
      status: "success",
      errorMessage: null,
    });

    return NextResponse.json({
      ok: true,
      cert,
      cache_hit: false,
      fetched_at: fetchedAt,
      source: "psa",
      data: freshData,
    });
  } catch (error) {
    const errorMessage = toErrorMessage(error);

    await logLookup({
      supabase,
      cert,
      cacheHit: false,
      status: "error",
      errorMessage,
    });

    return NextResponse.json({ ok: false, cert, error: errorMessage }, { status: 500 });
  }
}
