import { dbAdmin } from "@/lib/db/admin";
import type { SetSummaryVariantKey } from "@/lib/sets/refresh";

export type RollupQueueKey = SetSummaryVariantKey;

const QUEUE_CHUNK_SIZE = 500;

/**
 * Queue touched variant keys for deferred rollup processing.
 * Uses upsert with ignoreDuplicates to silently coalesce duplicate keys
 * across multiple concurrent pipeline jobs.
 */
export async function queuePendingRollups(
  keys: RollupQueueKey[],
): Promise<{ queued: number }> {
  if (keys.length === 0) return { queued: 0 };

  const deduped = new Map<string, RollupQueueKey>();
  for (const key of keys) {
    const canonicalSlug = String(key?.canonical_slug ?? "").trim();
    const variantRef = String(key?.variant_ref ?? "").trim();
    const provider = String(key?.provider ?? "").trim().toUpperCase();
    const grade = String(key?.grade ?? "RAW").trim().toUpperCase() || "RAW";
    if (!canonicalSlug || !variantRef || !provider) continue;
    deduped.set(
      `${canonicalSlug}::${variantRef}::${provider}::${grade}`,
      { canonical_slug: canonicalSlug, variant_ref: variantRef, provider, grade },
    );
  }

  const rows = [...deduped.values()];
  if (rows.length === 0) return { queued: 0 };

  const supabase = dbAdmin();
  let totalQueued = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rows.length; i += QUEUE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + QUEUE_CHUNK_SIZE).map((row) => ({
      canonical_slug: row.canonical_slug,
      variant_ref: row.variant_ref,
      provider: row.provider,
      grade: row.grade,
      queued_at: nowIso,
    }));

    const { error } = await supabase
      .from("pending_rollups")
      .upsert(chunk, {
        onConflict: "canonical_slug,variant_ref,provider,grade",
        ignoreDuplicates: true,
      });

    if (error) {
      throw new Error(`pending_rollups(queue): ${error.message}`);
    }
    totalQueued += chunk.length;
  }

  return { queued: totalQueued };
}

/**
 * Atomically claim and delete a batch of pending rollups via the
 * claim_pending_rollups SQL function. Returns the claimed keys ready
 * for passing to refreshPipelineRollupsForVariantKeys.
 */
export async function claimAndDeletePendingRollups(
  limit: number,
): Promise<{ keys: RollupQueueKey[]; count: number }> {
  const supabase = dbAdmin();
  const { data, error } = await supabase.rpc("claim_pending_rollups", {
    p_limit: Math.max(1, Math.floor(limit)),
  });

  if (error) {
    throw new Error(`pending_rollups(claim): ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    canonical_slug: string;
    variant_ref: string;
    provider: string;
    grade: string;
  }>;

  return {
    keys: rows.map((row) => ({
      canonical_slug: row.canonical_slug,
      variant_ref: row.variant_ref,
      provider: row.provider,
      grade: row.grade,
    })),
    count: rows.length,
  };
}

/** Count of rows currently queued for rollup processing. */
export async function getPendingRollupsCount(): Promise<number> {
  const supabase = dbAdmin();
  const { count, error } = await supabase
    .from("pending_rollups")
    .select("canonical_slug", { count: "exact", head: true });

  if (error) {
    throw new Error(`pending_rollups(count): ${error.message}`);
  }
  return count ?? 0;
}
