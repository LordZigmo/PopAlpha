#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_BASE_URL = "http://127.0.0.1:3001";
const DEFAULT_OUTPUT_PATH = path.join("/tmp", `popalpha-live-normalizer-smoke-${Date.now()}.json`);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseStringArg(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function providerConfig() {
  return [
    {
      provider: "JUSTTCG",
      endpoint: "/cards",
      route: "/api/cron/normalize-justtcg-raw",
      extraParams: { allowRetired: "1" },
    },
    {
      provider: "SCRYDEX",
      endpoint: "/en/expansions/{id}/cards",
      route: "/api/cron/normalize-pokemontcg-raw",
      extraParams: {},
    },
    {
      provider: "POKETRACE",
      endpoint: "/cards",
      route: "/api/cron/normalize-poketrace-raw",
      extraParams: {},
    },
  ];
}

async function fetchLatestPayloadId(supabase, config) {
  const { data, error } = await supabase
    .from("provider_raw_payloads")
    .select("id, fetched_at")
    .eq("provider", config.provider)
    .eq("endpoint", config.endpoint)
    .order("fetched_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`provider_raw_payloads(${config.provider} latest): ${error.message}`);
  if (!data?.id) throw new Error(`provider_raw_payloads(${config.provider} latest): no payload found`);
  return {
    rawPayloadId: String(data.id),
    fetchedAt: String(data.fetched_at),
  };
}

async function fetchLineageSummary(supabase, rawPayloadId) {
  const { data: lineageRow, error: lineageError } = await supabase
    .from("provider_raw_payload_lineages")
    .select("id, provider_raw_payload_id, provider, endpoint, fetched_at")
    .eq("provider_raw_payload_id", rawPayloadId)
    .maybeSingle();

  if (lineageError) {
    throw new Error(`provider_raw_payload_lineages(${rawPayloadId}): ${lineageError.message}`);
  }

  const { count, error: countError } = await supabase
    .from("provider_normalized_observations")
    .select("id", { count: "exact", head: true })
    .eq("provider_raw_payload_id", rawPayloadId);

  if (countError) {
    throw new Error(`provider_normalized_observations(count ${rawPayloadId}): ${countError.message}`);
  }

  let lineageMatchedCount = 0;
  if (lineageRow?.id) {
    const { count: matchedCount, error: matchedError } = await supabase
      .from("provider_normalized_observations")
      .select("id", { count: "exact", head: true })
      .eq("provider_raw_payload_id", rawPayloadId)
      .eq("provider_raw_payload_lineage_id", lineageRow.id);
    if (matchedError) {
      throw new Error(`provider_normalized_observations(lineage count ${rawPayloadId}): ${matchedError.message}`);
    }
    lineageMatchedCount = matchedCount ?? 0;
  }

  const { data: sampleRows, error: sampleError } = await supabase
    .from("provider_normalized_observations")
    .select("provider_raw_payload_id, provider_raw_payload_lineage_id, provider_card_id, provider_variant_id, updated_at")
    .eq("provider_raw_payload_id", rawPayloadId)
    .order("updated_at", { ascending: false })
    .limit(5);

  if (sampleError) {
    throw new Error(`provider_normalized_observations(sample ${rawPayloadId}): ${sampleError.message}`);
  }
  return {
    lineageRow: lineageRow ?? null,
    observationCount: count ?? 0,
    lineageMatchedCount,
    sampleRows: sampleRows ?? [],
  };
}

async function runNormalize(baseUrl, adminSecret, config, rawPayloadId) {
  const url = new URL(config.route, baseUrl);
  url.searchParams.set("payloads", "1");
  url.searchParams.set("force", "1");
  url.searchParams.set("rawId", rawPayloadId);
  for (const [key, value] of Object.entries(config.extraParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      "x-admin-secret": adminSecret,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${config.provider} normalize failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const adminSecret = requireEnv("ADMIN_SECRET");
  const baseUrl = parseStringArg(process.argv, "base-url", DEFAULT_BASE_URL);
  const outputPath = parseStringArg(process.argv, "out", DEFAULT_OUTPUT_PATH);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    outputPath,
    runs: [],
  };

  for (const config of providerConfig()) {
    const target = await fetchLatestPayloadId(supabase, config);
    const before = await fetchLineageSummary(supabase, target.rawPayloadId);
    const startedAt = new Date().toISOString();
    const result = await runNormalize(baseUrl, adminSecret, config, target.rawPayloadId);
    const after = await fetchLineageSummary(supabase, target.rawPayloadId);

    artifact.runs.push({
      provider: config.provider,
      endpoint: config.endpoint,
      route: config.route,
      rawPayloadId: target.rawPayloadId,
      fetchedAt: target.fetchedAt,
      startedAt,
      normalizeResult: result,
      verification: {
        before,
        after,
        lineagePopulated: after.observationCount > 0
          && after.lineageRow?.id != null
          && after.observationCount === after.lineageMatchedCount,
      },
    });
  }

  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ ok: true, outputPath, providers: artifact.runs.map((run) => run.provider) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
