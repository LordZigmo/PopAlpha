#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_OUTPUT_PATH = path.join("/tmp", `popalpha-provider-normalize-direct-${Date.now()}.json`);

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
      importPath: "../lib/backfill/justtcg-raw-normalize.ts",
      exportName: "runJustTcgRawNormalize",
    },
    {
      provider: "SCRYDEX",
      endpoint: "/en/expansions/{id}/cards",
      importPath: "../lib/backfill/pokemontcg-raw-normalize.ts",
      exportName: "runScrydexRawNormalize",
    },
    {
      provider: "POKETRACE",
      endpoint: "/cards",
      importPath: "../lib/backfill/poketrace-raw-normalize.ts",
      exportName: "runPokeTraceRawNormalize",
    },
  ];
}

async function fetchLatestPayload(supabase, config) {
  const { data, error } = await supabase
    .from("provider_raw_payloads")
    .select("id, fetched_at, response")
    .eq("provider", config.provider)
    .eq("endpoint", config.endpoint)
    .order("fetched_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(25);

  if (error) throw new Error(`provider_raw_payloads(${config.provider} latest): ${error.message}`);
  const rows = data ?? [];
  const selected = rows.find((row) => Array.isArray(row.response?.data) && row.response.data.length > 0)
    ?? rows[0];
  if (!selected?.id) throw new Error(`provider_raw_payloads(${config.provider} latest): no payload found`);
  return {
    rawPayloadId: String(selected.id),
    fetchedAt: String(selected.fetched_at),
  };
}

async function fetchVerification(supabase, rawPayloadId) {
  const { data: lineageRow, error: lineageError } = await supabase
    .from("provider_raw_payload_lineages")
    .select("id, provider_raw_payload_id, provider, endpoint, fetched_at")
    .eq("provider_raw_payload_id", rawPayloadId)
    .maybeSingle();
  if (lineageError) throw new Error(`provider_raw_payload_lineages(${rawPayloadId}): ${lineageError.message}`);

  const { count: observationCount, error: countError } = await supabase
    .from("provider_normalized_observations")
    .select("id", { count: "exact", head: true })
    .eq("provider_raw_payload_id", rawPayloadId);
  if (countError) throw new Error(`provider_normalized_observations(count ${rawPayloadId}): ${countError.message}`);

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
    observationCount: observationCount ?? 0,
    lineageMatchedCount,
    sampleRows: sampleRows ?? [],
    lineagePopulated: (observationCount ?? 0) > 0
      && lineageRow?.id != null
      && (observationCount ?? 0) === lineageMatchedCount,
  };
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const outputPath = parseStringArg(process.argv, "out", DEFAULT_OUTPUT_PATH);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    outputPath,
    runs: [],
  };

  for (const config of providerConfig()) {
    const target = await fetchLatestPayload(supabase, config);
    const before = await fetchVerification(supabase, target.rawPayloadId);
    const imported = await import(config.importPath);
    const runNormalize = imported[config.exportName];
    if (typeof runNormalize !== "function") {
      throw new Error(`${config.importPath} is missing ${config.exportName}`);
    }

    const startedAt = new Date().toISOString();
    const normalizeResult = await runNormalize({
      payloadLimit: 1,
      rawPayloadId: target.rawPayloadId,
      force: true,
    });
    const after = await fetchVerification(supabase, target.rawPayloadId);

    artifact.runs.push({
      provider: config.provider,
      endpoint: config.endpoint,
      rawPayloadId: target.rawPayloadId,
      fetchedAt: target.fetchedAt,
      startedAt,
      normalizeResult,
      verification: {
        before,
        after,
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
