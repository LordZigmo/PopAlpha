import { dbAdmin } from "@/lib/db/admin";
import type { PricingTransparencySnapshot } from "@/lib/data/freshness";

type AlertCandidate = {
  metric: string;
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  comparator: "gte" | "lte";
};

function hourBucket(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 13);
  return date.toISOString().slice(0, 13);
}

function buildCandidates(snapshot: PricingTransparencySnapshot): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];
  const freshnessPct = Number.parseFloat(snapshot.slo.find((row) => row.key === "freshness_24h")?.value ?? "0");
  if (Number.isFinite(freshnessPct) && freshnessPct <= 85) {
    candidates.push({
      metric: "freshness_24h",
      severity: freshnessPct <= 75 ? "critical" : "warning",
      message: `Freshness dropped to ${freshnessPct.toFixed(2)}% (target >= 90%).`,
      value: freshnessPct,
      threshold: 85,
      comparator: "lte",
    });
  }

  if (snapshot.anomalies.providerDivergenceGt80PctCount >= 60) {
    candidates.push({
      metric: "provider_divergence_spike",
      severity: snapshot.anomalies.providerDivergenceGt80PctCount >= 120 ? "critical" : "warning",
      message: `Provider divergence spike: ${snapshot.anomalies.providerDivergenceGt80PctCount} cards >80% spread.`,
      value: snapshot.anomalies.providerDivergenceGt80PctCount,
      threshold: 60,
      comparator: "gte",
    });
  }

  if (snapshot.anomalies.zeroChange24hCount >= 250) {
    candidates.push({
      metric: "zero_change_spike",
      severity: snapshot.anomalies.zeroChange24hCount >= 500 ? "critical" : "warning",
      message: `Zero-change spike: ${snapshot.anomalies.zeroChange24hCount} cards at 0% 24h change.`,
      value: snapshot.anomalies.zeroChange24hCount,
      threshold: 250,
      comparator: "gte",
    });
  }

  if (snapshot.anomalies.nullChange24hCount >= 40) {
    candidates.push({
      metric: "null_change_spike",
      severity: snapshot.anomalies.nullChange24hCount >= 100 ? "critical" : "warning",
      message: `Null 24h change spike: ${snapshot.anomalies.nullChange24hCount} cards missing 24h change.`,
      value: snapshot.anomalies.nullChange24hCount,
      threshold: 40,
      comparator: "gte",
    });
  }

  if ((snapshot.pipelineHealth.retryDepth ?? 0) >= 20) {
    candidates.push({
      metric: "pipeline_retry_depth",
      severity: (snapshot.pipelineHealth.retryDepth ?? 0) >= 40 ? "critical" : "warning",
      message: `Pipeline retry depth elevated: ${snapshot.pipelineHealth.retryDepth ?? 0}.`,
      value: snapshot.pipelineHealth.retryDepth ?? 0,
      threshold: 20,
      comparator: "gte",
    });
  }

  return candidates;
}

async function computeMutedMoverStreakHours(params: {
  currentMedianMove: number | null;
  threshold: number;
  lookbackHours: number;
}): Promise<number> {
  const current = params.currentMedianMove;
  if (!(typeof current === "number" && Number.isFinite(current) && current > 0)) return 0;
  if (current >= params.threshold) return 0;

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("pricing_transparency_snapshots")
    .select("captured_at, payload")
    .order("captured_at", { ascending: false })
    .limit(Math.max(1, params.lookbackHours - 1));
  if (error) return 1;

  let streak = 1; // include current hour
  for (const row of (data ?? []) as Array<{
    payload: {
      moversHealth?: { highConfidenceTop10MedianAbsChangePct?: number | null };
    } | null;
  }>) {
    const prior = row.payload?.moversHealth?.highConfidenceTop10MedianAbsChangePct;
    if (!(typeof prior === "number" && Number.isFinite(prior) && prior > 0 && prior < params.threshold)) break;
    streak += 1;
  }
  return streak;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deliverPricingThresholdAlerts(snapshot: PricingTransparencySnapshot): Promise<{
  candidates: number;
  delivered: number;
}> {
  const webhookUrl = process.env.POPALPHA_ALERT_WEBHOOK_URL?.trim() ?? "";
  const slackWebhookUrl = process.env.POPALPHA_SLACK_WEBHOOK_URL?.trim() ?? "";
  const candidates = buildCandidates(snapshot);
  const mutedMoverStreak = await computeMutedMoverStreakHours({
    currentMedianMove: snapshot.moversHealth.highConfidenceTop10MedianAbsChangePct,
    threshold: 3,
    lookbackHours: 6,
  });
  if (mutedMoverStreak >= 6) {
    candidates.push({
      metric: "top_movers_muted_streak",
      severity: (snapshot.moversHealth.highConfidenceTop10MedianAbsChangePct ?? 0) < 2 ? "critical" : "warning",
      message: `Top-10 mover median stayed below 3% for ${mutedMoverStreak}h (now ${(snapshot.moversHealth.highConfidenceTop10MedianAbsChangePct ?? 0).toFixed(2)}%).`,
      value: snapshot.moversHealth.highConfidenceTop10MedianAbsChangePct ?? 0,
      threshold: 3,
      comparator: "lte",
    });
  }
  if (!webhookUrl && !slackWebhookUrl) {
    return { candidates: candidates.length, delivered: 0 };
  }

  const bucket = hourBucket(snapshot.asOf);
  const supabase = dbAdmin();
  let delivered = 0;

  for (const alert of candidates) {
    const eventKey = `${alert.metric}:${bucket}`;
    const { data: existing } = await supabase
      .from("pricing_alert_events")
      .select("id")
      .eq("event_key", eventKey)
      .eq("severity", alert.severity)
      .maybeSingle();
    if (existing?.id) continue;

    const payload = {
      asOf: snapshot.asOf,
      metric: alert.metric,
      severity: alert.severity,
      value: alert.value,
      threshold: alert.threshold,
      comparator: alert.comparator,
      message: alert.message,
      alerts: snapshot.alerts,
    };

    const deliveredTo: string[] = [];
    if (webhookUrl) {
      const ok = await postJson(webhookUrl, {
        source: "pricing_transparency",
        ...payload,
      });
      if (ok) deliveredTo.push("webhook");
    }

    if (slackWebhookUrl) {
      const ok = await postJson(slackWebhookUrl, {
        text: `[PopAlpha][${alert.severity.toUpperCase()}] ${alert.message}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*PopAlpha Pricing Alert*\n*Severity:* ${alert.severity}\n*Metric:* ${alert.metric}\n*Message:* ${alert.message}\n*As of:* ${snapshot.asOf}`,
            },
          },
        ],
      });
      if (ok) deliveredTo.push("slack");
    }

    const { error } = await supabase.from("pricing_alert_events").insert({
      event_key: eventKey,
      severity: alert.severity,
      message: alert.message,
      payload,
      delivered_to: deliveredTo,
    });
    if (!error && deliveredTo.length > 0) delivered += 1;
  }

  return { candidates: candidates.length, delivered };
}
