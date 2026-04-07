import { dbAdmin } from "@/lib/db/admin";
import { computePricingTransparencySnapshot } from "@/lib/data/freshness";
import { captureOutlierDiagnostics } from "@/lib/backfill/outlier-diagnostics-capture";
import { deliverPricingThresholdAlerts } from "@/lib/backfill/pricing-threshold-alerts";

export async function capturePricingTransparencySnapshot(): Promise<{ ok: boolean; id: number | null }> {
  const supabase = dbAdmin();
  try {
    await captureOutlierDiagnostics({
      lookbackHours: 24,
      sampleLimit: 6000,
      upsertLimit: 1500,
    });
  } catch (error) {
    console.warn("[capturePricingTransparencySnapshot:outliers]", error);
  }
  const snapshot = await computePricingTransparencySnapshot();
  let alertDelivery = { candidates: 0, delivered: 0 };
  try {
    alertDelivery = await deliverPricingThresholdAlerts(snapshot);
  } catch (error) {
    console.warn("[capturePricingTransparencySnapshot:alerts]", error);
  }
  const freshnessValue = snapshot.slo.find((row) => row.key === "freshness_24h");
  const { data, error } = await supabase
    .from("pricing_transparency_snapshots")
    .insert({
      freshness_pct: freshnessValue ? Number.parseFloat(freshnessValue.value) : null,
      coverage_both_pct: snapshot.coverage.marketPct,
      p90_spread_pct: snapshot.priceAgreement.p90SpreadPct,
      queue_depth: snapshot.pipelineHealth.queueDepth,
      retry_depth: snapshot.pipelineHealth.retryDepth,
      failed_depth: snapshot.pipelineHealth.failedDepth,
      payload: {
        ...snapshot,
        alertDelivery,
      },
    })
    .select("id")
    .single<{ id: number }>();
  if (error) throw new Error(`pricing_transparency_snapshots(insert): ${error.message}`);
  return { ok: true, id: data.id };
}
