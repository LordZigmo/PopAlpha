import { NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import { getCertificate, type CertificateResponse } from "@/lib/psa/client";
import { dbAdmin } from "@/lib/db/admin";
import { buildSnapshotParsed, hashSnapshotParsed } from "@/lib/psa/snapshot";
import { runPsaSpecMatch } from "@/lib/backfill/psa-spec-match";
import { measureAsync } from "@/lib/perf";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** PSA cert numbers are numeric, typically 5–10 digits (older certs ~5, modern 8–10). */
const CERT_PATTERN = /^\d{4,12}$/;

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });

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

/**
 * Harvest the cert's SpecID into the population-snapshot rotation
 * (psa_spec_targets → snapshot-psa-pop cron). Every scanned slab grows
 * pop-over-time coverage organically. Best-effort: a failure here must
 * never break the lookup the user is waiting on.
 */
async function harvestSpecTarget(params: {
  supabase: SupabaseClient;
  data: CertificateResponse;
}) {
  try {
    const raw = params.data.raw as Record<string, unknown> | null;
    const psaCert =
      raw && typeof raw.PSACert === "object" && raw.PSACert !== null
        ? (raw.PSACert as Record<string, unknown>)
        : null;
    const specIdValue = psaCert?.SpecID;
    const specId =
      typeof specIdValue === "number" && Number.isInteger(specIdValue)
        ? specIdValue
        : typeof specIdValue === "string"
          ? Number.parseInt(specIdValue, 10)
          : NaN;
    if (!Number.isInteger(specId) || specId <= 0) return;

    const description = ["Year", "Brand", "CardNumber", "Subject", "Variety"]
      .map((key) => {
        const v = psaCert?.[key];
        return typeof v === "string" ? v.trim() : "";
      })
      .filter(Boolean)
      .join(" ");

    const { error } = await params.supabase.from("psa_spec_targets").upsert(
      {
        spec_id: specId,
        ...(description ? { description } : {}),
        source: "cert_scan",
      },
      { onConflict: "spec_id", ignoreDuplicates: true }
    );
    if (error) {
      console.warn("[psa/cert] spec target harvest failed", { specId, error: error.message });
      return;
    }

    // Match-on-arrival (Population Tables Phase 2): try to map the spec
    // to a canonical card while the cert payload is hot. The runner skips
    // already-MATCHED/verified specs in one cheap query, so repeat scans
    // cost almost nothing. Time-boxed — the daily match-psa-specs sweep
    // is the backstop for anything skipped here.
    const matchTimeoutMs = 2500;
    await Promise.race([
      runPsaSpecMatch({ specId, logRun: false }).then((result) => {
        if (!result.ok) {
          console.warn("[psa/cert] spec match attempt failed", {
            specId,
            error: result.firstError,
          });
        }
      }),
      new Promise<void>((resolve) => setTimeout(resolve, matchTimeoutMs)),
    ]);
  } catch (error) {
    console.warn("[psa/cert] spec target harvest threw", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeSnapshot(params: {
  supabase: SupabaseClient;
  cert: string;
  source: string;
  fetchedAt: string;
  data: CertificateResponse;
}) {
  const snapshotParsed = buildSnapshotParsed(params.data);
  const snapshotHash = hashSnapshotParsed(snapshotParsed);

  const { error: snapshotError } = await params.supabase.from("psa_cert_snapshots").upsert(
    {
      cert: params.cert,
      fetched_at: params.fetchedAt,
      source: params.source,
      parsed: snapshotParsed,
      raw: params.data.raw,
      hash: snapshotHash,
    },
    {
      onConflict: "cert,hash",
      ignoreDuplicates: true,
    }
  );

  if (snapshotError) {
    throw new Error(`Failed writing psa_cert_snapshots: ${snapshotError.message}`);
  }

  const { error: eventError } = await params.supabase.from("market_events").insert({
    asset_type: "psa_cert",
    asset_ref: params.cert,
    source: params.source,
    event_type: "psa_fetch",
    occurred_at: params.fetchedAt,
    metadata: {
      snapshot_hash: snapshotHash,
    },
  });

  if (eventError) {
    throw new Error(`Failed writing market_events: ${eventError.message}`);
  }
}

export async function GET(req: Request) {
  const cert = sanitizeCert(new URL(req.url).searchParams.get("cert"));

  if (!cert) {
    return NextResponse.json(
      { ok: false, error: "Missing cert query param. Example: /api/psa/cert?cert=12345678" },
      { status: 400 }
    );
  }

  if (!CERT_PATTERN.test(cert)) {
    return NextResponse.json(
      { ok: false, error: "Invalid cert number format." },
      { status: 400 }
    );
  }

  // Rate limit by IP — 10 requests per minute per IP.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimiter(ip);
  if (!rl.allowed) {
    console.warn("[psa/cert] rate-limited", { ip, cert });
    return new NextResponse(
      JSON.stringify({ ok: false, error: "Rate limit exceeded." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
        },
      }
    );
  }

  let supabase: SupabaseClient;
  try {
    supabase = dbAdmin();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Server configuration error: missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
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

    const freshData = await measureAsync("cert.fetch.psa", { cert }, () => getCertificate(cert));
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

    await writeSnapshot({
      supabase,
      cert,
      source: "psa",
      fetchedAt,
      data: freshData,
    });

    await harvestSpecTarget({ supabase, data: freshData });

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
