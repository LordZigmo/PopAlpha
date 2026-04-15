import "server-only";

import { dbAdmin } from "@/lib/db/admin";
import { retrySupabaseWriteOperation } from "@/lib/backfill/supabase-write-retry";
import type { ConditionPriceEntry } from "@/lib/backfill/scrydex-condition-price-extract";

export type WriteConditionPricesParams = {
  canonicalSlug: string;
  printingId: string | null;
  conditionPrices: Map<string, ConditionPriceEntry>;
  provider: string;
  observedAt: string;
};

/**
 * Upsert condition prices into card_condition_prices.
 * Returns the number of rows upserted.
 */
export async function writeConditionPrices(params: WriteConditionPricesParams): Promise<number> {
  const { canonicalSlug, printingId, conditionPrices, provider, observedAt } = params;
  if (conditionPrices.size === 0) return 0;

  const rows = Array.from(conditionPrices.entries()).map(([condition, entry]) => ({
    canonical_slug: canonicalSlug,
    printing_id: printingId,
    condition,
    price: entry.price,
    low_price: entry.lowPrice,
    high_price: entry.highPrice,
    currency: entry.currency,
    provider,
    observed_at: observedAt,
    updated_at: new Date().toISOString(),
  }));

  const supabase = dbAdmin();
  await retrySupabaseWriteOperation(
    `condition-prices:${canonicalSlug}`,
    async () => {
      const { error } = await supabase
        .from("card_condition_prices")
        .upsert(rows, { onConflict: "canonical_slug,printing_id,condition" });
      if (error) throw new Error(`condition price upsert failed: ${error.message}`);
    },
    { maxAttempts: 3 },
  );

  return rows.length;
}
