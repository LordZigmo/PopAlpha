import { useCallback, useEffect, useMemo, useState } from "react";
import type { CertificateResponse } from "@/lib/psa/client";
import RawJsonPanel from "@/components/raw-json-panel";
import StatCard from "@/components/stat-card";
import RarityRing from "@/components/rarity-ring";
import PopulationBar from "@/components/population-bar";
import ProceedsCalculator from "@/components/proceeds-calculator";
import PrivateSalesForm, { type SaleFormState } from "@/components/private-sales-form";
import PrivateSalesList, { type PrivateSale } from "@/components/private-sales-list";
import { getDerivedMetrics } from "@/lib/cert-metrics";
import { buildPsaCertUrl } from "@/lib/psa/cert-url";
import { buildCardSlug } from "@/lib/card-slug";

type CertDetailsCardProps = {
  cert: string;
  data: CertificateResponse;
  source?: string;
  cacheHit?: boolean;
  fetchedAt?: string;
  rawLookup: unknown;
  watchlistSaved?: boolean;
  onToggleWatchlist?: () => void;
};

type DisplayValue = string | number | null | undefined;
type TabKey = "overview" | "activity" | "market" | "private" | "raw";
type ActivityEvent = {
  type: string;
  summary: string;
  occurred_at: string;
  details: Record<string, unknown>;
};
type CanonicalMatch = {
  slug: string;
  canonical_name: string;
  score: number;
};
type CardProfile = {
  card_slug: string;
  summary_short: string;
  summary_long: string | null;
  created_at: string;
};

function normalizeRaw(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const payload = raw as Record<string, unknown>;
  const nested = payload.PSACert ?? payload.Result ?? payload.data;
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : payload;
}

function firstValue(payload: Record<string, unknown>, keys: string[]): DisplayValue {
  for (const key of keys) {
    const value = payload[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value as DisplayValue;
  }
  return null;
}

function display(value: DisplayValue): string {
  if (value === null || value === undefined) return "—";
  const next = String(value).trim();
  return next === "" ? "—" : next;
}

function isLikelyUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function dateToInput(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function formatUpdated(value?: string): string {
  if (!value) return "Updated —";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Updated —";
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed)}`;
}

function formatShare(value: number | null): string {
  if (value === null) return "—";
  const n = value * 100;
  return `${Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function getLiquiditySignal(totalPopulation: number | null): "High liquidity" | "Moderate" | "Thin" | "Unknown" {
  if (totalPopulation === null) return "Unknown";
  if (totalPopulation > 10000) return "High liquidity";
  if (totalPopulation >= 1000) return "Moderate";
  return "Thin";
}

function getPositionInsight(
  totalPopulation: number | null,
  populationHigher: number | null,
  scarcityScore: number | null,
): string {
  if (totalPopulation === null || populationHigher === null) return "Insufficient population coverage";
  if (totalPopulation === 1 && populationHigher === 0) return "Ultra-scarce: unique population at this grade";

  if (populationHigher === 0 && totalPopulation < 500) return "Elite scarcity tier";
  if (totalPopulation > 0 && populationHigher / totalPopulation > 0.8) return "High grade compression";
  if (totalPopulation > 10000) return "High supply / high liquidity environment";
  if (totalPopulation < 1000) return "Thin market structure";
  if (scarcityScore !== null && scarcityScore >= 80) return "Scarcity-led positioning";

  return "Balanced population profile";
}

function getMarketPosition(totalPopulation: number | null, populationHigher: number | null) {
  if (totalPopulation === null || populationHigher === null || totalPopulation <= 0) {
    return { percentHigher: null as number | null, label: "Insufficient distribution data" };
  }

  const percentHigher = (populationHigher / totalPopulation) * 100;
  if (populationHigher === 0) return { percentHigher, label: "Price Discovery Tier" };
  if (percentHigher < 10) return { percentHigher, label: "Top percentile grade" };
  if (percentHigher < 40) return { percentHigher, label: "Upper tier grade" };
  if (percentHigher < 70) return { percentHigher, label: "Mid distribution grade" };
  return { percentHigher, label: "High supply grade" };
}

function getSupplyPressure(totalPopulation: number | null, populationHigher: number | null) {
  if (totalPopulation === null || populationHigher === null || totalPopulation <= 0) {
    return { ratio: null as number | null, label: "Unknown", tone: "neutral" as "positive" | "warning" | "negative" | "neutral" };
  }

  const ratio = populationHigher / totalPopulation;
  if (ratio < 0.1) return { ratio, label: "Low supply pressure", tone: "positive" as const };
  if (ratio < 0.4) return { ratio, label: "Moderate supply pressure", tone: "warning" as const };
  return { ratio, label: "High supply pressure", tone: "negative" as const };
}

function getLiquidityTier(totalPopulation: number | null): string {
  if (totalPopulation === null) return "Unknown";
  if (totalPopulation < 10) return "Ultra thin market";
  if (totalPopulation < 100) return "Thin market";
  if (totalPopulation < 5000) return "Moderate liquidity";
  return "High liquidity";
}

function getDeterministicCertSummary(grade: string, totalPopulation: number | null, populationHigher: number | null, scarcityScore: number | null): string {
  if (populationHigher === 0) {
    return `This ${grade} example sits at the highest recorded PSA grade with no higher examples.`;
  }

  if (totalPopulation !== null && totalPopulation > 0 && populationHigher !== null) {
    const percentHigher = (populationHigher / totalPopulation) * 100;
    const formatted = Number.isInteger(percentHigher) ? String(percentHigher) : percentHigher.toFixed(1).replace(/\.0$/, "");
    return `${formatted}% of graded examples are higher than this copy.`;
  }

  if (scarcityScore !== null) {
    return `Scarcity score reads ${scarcityScore}, indicating relative population pressure at this grade.`;
  }

  return "Population context is limited for this cert.";
}

export default function CertDetailsCard({
  cert,
  data,
  source,
  cacheHit,
  fetchedAt,
  rawLookup,
  watchlistSaved = false,
  onToggleWatchlist,
}: CertDetailsCardProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [sales, setSales] = useState<PrivateSale[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [saleToast, setSaleToast] = useState<string | null>(null);
  const [saleSubmitting, setSaleSubmitting] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [cardProfile, setCardProfile] = useState<CardProfile | null>(null);
  const [canonicalMatch, setCanonicalMatch] = useState<CanonicalMatch | null>(null);
  const [saleForm, setSaleForm] = useState<SaleFormState>({
    soldAt: dateToInput(new Date().toISOString()),
    price: "",
    fees: "",
    paymentMethod: "",
    notes: "",
  });

  const rawPayload = normalizeRaw(data.raw);
  const grade = data.parsed.grade ?? firstValue(rawPayload, ["GradeDescription", "CardGrade", "grade", "Grade"]);
  const year = data.parsed.year ?? firstValue(rawPayload, ["Year", "year"]);
  const brand = firstValue(rawPayload, ["Brand", "brand"]);
  const subject = data.parsed.subject ?? firstValue(rawPayload, ["Subject", "subject"]);
  const variety = data.parsed.variety ?? firstValue(rawPayload, ["Variety", "variety"]);
  const category = firstValue(rawPayload, ["Category", "category", "Sport"]);
  const labelType = data.parsed.label ?? firstValue(rawPayload, ["LabelType", "label", "Label"]);
  const cardNumber = firstValue(rawPayload, ["CardNumber", "card_number", "CardNo", "No"]);
  const imageUrl = data.parsed.image_url ?? firstValue(rawPayload, [
    "ImageUrlLarge",
    "ImageURLLarge",
    "FrontImageLarge",
    "BackImageLarge",
    "CardImageLarge",
    "PictureUrlLarge",
    "SecureScanUrl",
    "ImageURL",
    "ImageUrl",
    "FrontImage",
    "BackImage",
    "CardImage",
    "PictureUrl",
    "ImageUrlSmall",
    "ImageURLSmall",
  ]);
  const totalPopulation = firstValue(rawPayload, ["TotalPopulation", "totalPopulation"]);
  const populationHigher = firstValue(rawPayload, ["PopulationHigher", "populationHigher"]);

  const metrics = useMemo(() => getDerivedMetrics(totalPopulation, populationHigher), [totalPopulation, populationHigher]);

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "activity", label: "Activity" },
    { key: "market", label: "Market" },
    { key: "private", label: "Private Sales" },
    { key: "raw", label: "Raw Data" },
  ];

  const loadPrivateSales = useCallback(async () => {
    setSalesLoading(true);
    setSalesError(null);
    try {
      const response = await fetch(`/api/private-sales?cert=${encodeURIComponent(cert)}`);
      const payload = (await response.json()) as { ok: boolean; sales?: PrivateSale[]; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Failed to load private sales.");
      setSales(payload.sales ?? []);
    } catch (error) {
      setSalesError(String(error));
      setSales([]);
    } finally {
      setSalesLoading(false);
    }
  }, [cert]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const response = await fetch(`/api/psa/cert/activity?cert=${encodeURIComponent(cert)}&limit=20`);
      const payload = (await response.json()) as {
        ok: boolean;
        snapshot_count?: number;
        events?: ActivityEvent[];
        error?: string;
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Failed to load activity.");
      setHistoryCount(payload.snapshot_count ?? 0);
      setActivityEvents(payload.events ?? []);
    } catch (error) {
      setActivityError(String(error));
      setHistoryCount(0);
      setActivityEvents([]);
    } finally {
      setActivityLoading(false);
    }
  }, [cert]);

  const cardSlug = useMemo(() => buildCardSlug([year, brand, subject, variety]), [year, brand, subject, variety]);

  const loadCardProfile = useCallback(async () => {
    if (!cardSlug) {
      setCardProfile(null);
      return;
    }

    try {
      const response = await fetch(`/api/card-profiles?slug=${encodeURIComponent(cardSlug)}`);
      const payload = (await response.json()) as { ok: boolean; profile?: CardProfile | null };
      if (!response.ok || !payload.ok) {
        setCardProfile(null);
        return;
      }
      setCardProfile(payload.profile ?? null);
    } catch {
      setCardProfile(null);
    }
  }, [cardSlug]);

  const loadCanonicalMatch = useCallback(async () => {
    const subjectText = display(subject);
    if (subjectText === "—") {
      setCanonicalMatch(null);
      return;
    }

    const params = new URLSearchParams({
      subject: subjectText,
    });
    if (year !== null && year !== undefined && String(year) !== "—") params.set("year", String(year));
    if (display(brand) !== "—") params.set("set_name", display(brand));
    if (display(cardNumber) !== "—") params.set("card_number", display(cardNumber));
    if (display(variety) !== "—") params.set("variant", display(variety));

    try {
      const response = await fetch(`/api/canonical/match?${params.toString()}`);
      const payload = (await response.json()) as { ok: boolean; match?: CanonicalMatch | null };
      if (!response.ok || !payload.ok) {
        setCanonicalMatch(null);
        return;
      }
      setCanonicalMatch(payload.match ?? null);
    } catch {
      setCanonicalMatch(null);
    }
  }, [subject, year, brand, cardNumber, variety]);

  useEffect(() => {
    if (activeTab === "private") void loadPrivateSales();
  }, [activeTab, loadPrivateSales]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    void loadCardProfile();
  }, [loadCardProfile]);

  useEffect(() => {
    void loadCanonicalMatch();
  }, [loadCanonicalMatch]);

  useEffect(() => {
    if (!saleToast) return;
    const timer = window.setTimeout(() => setSaleToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [saleToast]);

  async function submitSale() {
    setSaleSubmitting(true);
    try {
      const response = await fetch("/api/private-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cert,
          price: Number(saleForm.price),
          sold_at: new Date(`${saleForm.soldAt}T12:00:00.000Z`).toISOString(),
          fees: saleForm.fees ? Number(saleForm.fees) : null,
          payment_method: saleForm.paymentMethod || null,
          notes: saleForm.notes || null,
        }),
      });
      const payload = (await response.json()) as { ok: boolean; sale?: PrivateSale; error?: string };
      if (!response.ok || !payload.ok || !payload.sale) throw new Error(payload.error ?? "Failed to save private sale.");
      setSales((prev) => [payload.sale as PrivateSale, ...prev]);
      setSaleForm((prev) => ({ ...prev, price: "", fees: "", notes: "", paymentMethod: "" }));
      setSaleToast("Private sale saved.");
    } catch (error) {
      setSaleToast(String(error));
    } finally {
      setSaleSubmitting(false);
    }
  }

  async function removeSale(id: string) {
    try {
      const response = await fetch(`/api/private-sales/${id}`, { method: "DELETE" });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Delete failed");
      setSales((prev) => prev.filter((sale) => sale.id !== id));
      setSaleToast("Private sale removed.");
    } catch (error) {
      setSaleToast(String(error));
    }
  }

  const title =
    [display(year), display(brand), display(subject), display(variety)].filter((v) => v !== "—").join(" • ") ||
    "Unspecified listing";
  const updatedText = formatUpdated(fetchedAt);

  const higherCount =
    metrics.populationHigher !== null && metrics.populationHigher >= 0 ? Math.round(metrics.populationHigher) : null;
  const totalCount =
    metrics.totalPopulation !== null && metrics.totalPopulation >= 0 ? Math.round(metrics.totalPopulation) : null;
  const atGradeOrLowerCount =
    totalCount !== null && higherCount !== null ? Math.max(totalCount - higherCount, 0) : null;
  const ultraScarce = totalCount === 1 && higherCount === 0;
  const liquiditySignal = getLiquiditySignal(metrics.totalPopulation);
  const liquidityChipClass =
    liquiditySignal === "High liquidity"
      ? "badge-positive"
      : liquiditySignal === "Moderate"
        ? "border-app text-app bg-surface-soft"
        : liquiditySignal === "Thin"
          ? "badge-negative"
          : "border-app text-muted bg-surface-soft";
  const positionInsight = getPositionInsight(metrics.totalPopulation, metrics.populationHigher, metrics.scarcityScore);
  const marketPosition = getMarketPosition(metrics.totalPopulation, metrics.populationHigher);
  const supplyPressure = getSupplyPressure(metrics.totalPopulation, metrics.populationHigher);
  const liquidityTier = getLiquidityTier(metrics.totalPopulation);
  const hasPsaScan = typeof imageUrl === "string" && imageUrl.trim() !== "" && isLikelyUrl(imageUrl);
  const imageUrlString = hasPsaScan ? imageUrl : "";
  const psaCertUrl = buildPsaCertUrl(cert);
  const pressureClass =
    supplyPressure.tone === "positive"
      ? "badge-positive"
      : supplyPressure.tone === "warning"
        ? "border-app text-app bg-surface-soft"
        : supplyPressure.tone === "negative"
          ? "badge-negative"
          : "border-app text-muted bg-surface-soft";
  const deterministicSummary = getDeterministicCertSummary(display(grade), metrics.totalPopulation, metrics.populationHigher, metrics.scarcityScore);

  return (
    <section className="glass glow-card lift density-panel rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <article
          className="glass rounded-[var(--radius-panel)] border-app border"
          style={{ padding: "calc(var(--space-panel) * 0.88) var(--space-panel)" }}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-app text-5xl font-semibold sm:text-6xl">{display(grade)}</p>
              <p className="text-app mt-3 text-base">{title}</p>
              <div className="mt-2">
                {canonicalMatch ? (
                  <a
                    href={`/cards/${encodeURIComponent(canonicalMatch.slug)}`}
                    className="btn-accent inline-flex rounded-[var(--radius-input)] border px-3 py-1.5 text-xs font-semibold"
                  >
                    View Card
                  </a>
                ) : display(subject) !== "—" ? (
                  <a
                    href={`/search?q=${encodeURIComponent(display(subject))}`}
                    className="text-muted text-xs underline underline-offset-4"
                  >
                    Find card
                  </a>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-start gap-3">
              <div className="w-[4.35rem] shrink-0">
                <div className="glass relative h-24 w-[4.35rem] overflow-hidden rounded-[var(--radius-input)] border-app border bg-surface-soft">
                  {hasPsaScan ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrlString}
                      alt="PSA cert asset"
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-full w-full bg-[radial-gradient(circle_at_20%_12%,color-mix(in_srgb,var(--color-accent)_26%,transparent),transparent_56%),linear-gradient(165deg,color-mix(in_srgb,var(--color-surface-soft)_88%,transparent),color-mix(in_srgb,var(--color-border)_36%,transparent))]" />
                  )}
                </div>
                <a
                  href={psaCertUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost mt-2 block rounded-[var(--radius-input)] border px-2 py-1 text-center text-[11px] font-semibold"
                >
                  View on PSA
                </a>
                {!hasPsaScan ? <p className="text-muted mt-1 text-[11px]">PSA scans unavailable for this cert</p> : null}
              </div>
              <div className="w-[11.5rem]">
                <RarityRing score={metrics.scarcityScore} compact />
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="border-app rounded-full border px-3 py-1">Cert #{cert}</span>
            <span className="border-app rounded-full border px-3 py-1">Category: {display(category)}</span>
            <span className="border-app rounded-full border px-3 py-1">Label: {display(labelType)}</span>
            <span className={`rounded-full border px-3 py-1 ${hasPsaScan ? "badge-positive" : "border-app text-muted bg-surface-soft"}`}>
              PSA scan: {hasPsaScan ? "available" : "unavailable"}
            </span>
            {onToggleWatchlist ? (
              <button
                type="button"
                onClick={onToggleWatchlist}
                className={`rounded-full border px-3 py-1 transition ${
                  watchlistSaved ? "badge-positive" : "btn-ghost"
                }`}
              >
                {watchlistSaved ? "Watchlist saved" : "Save to watchlist"}
              </button>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">{updatedText}</span>
            <span className="border-app rounded-full border px-2 py-1 text-muted">
              Source: {source === "cache" ? "Cache" : "PSA"}
            </span>
            <span className="border-app rounded-full border px-2 py-1 text-muted">
              Cache: {cacheHit ? "Hit" : "Miss"}
            </span>
            <span className="border-app rounded-full border px-2 py-1 text-muted">
              History: {historyCount === null ? "…" : historyCount}
            </span>
          </div>
        </article>

        <aside className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          <StatCard
            label="Total Pop"
            value={display(totalPopulation)}
            headerRight={
              ultraScarce ? (
                <span className="badge-gold rounded-full px-3 py-1 text-xs font-semibold">1 of 1</span>
              ) : null
            }
            sublabel={
              <span className="mt-1 inline-flex items-center gap-2">
                <span>Total graded examples</span>
                {!ultraScarce ? (
                  <span className={`rounded-full border px-2 py-0.5 ${liquidityChipClass}`}>{liquiditySignal}</span>
                ) : null}
              </span>
            }
          />
          <StatCard label="Population Higher" value={display(populationHigher)} sublabel="Examples in higher grades" />
          <StatCard
            label="Verdict"
            value={metrics.topGrade ? "Top tier" : "Not top tier"}
            sublabel={metrics.topGrade ? "None higher recorded" : "Higher grades are recorded"}
            highlight={metrics.topGrade}
            tierAccent
          />
          <div className="glass density-card rounded-[var(--radius-card)] border-app border p-[var(--space-card)]">
            <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Position Insight</p>
            <p className="text-app mt-2 text-lg font-semibold leading-tight">{positionInsight}</p>
            <p className="text-muted mt-1 text-xs">
              {metrics.scarcityScore === null ? "Scarcity unavailable" : `Scarcity score ${metrics.scarcityScore}`}
            </p>
          </div>
          <StatCard
            label="At grade or lower"
            value={formatShare(metrics.topTierShare)}
          />
        </aside>
      </div>

      <div className="mt-4">
        <PopulationBar
          higherShare={metrics.higherShare}
          topTierShare={metrics.topTierShare}
          higherCount={higherCount}
          atGradeOrLowerCount={atGradeOrLowerCount}
        />
      </div>

      {cardProfile ? (
        <section className="mt-4 rounded-[var(--radius-panel)] border-app border bg-surface/70 p-[var(--space-panel)]">
          <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Card Overview</p>
          <p className="text-app mt-2 text-base font-semibold">{cardProfile.summary_short}</p>
          {cardProfile.summary_long ? <p className="text-muted mt-2 text-sm">{cardProfile.summary_long}</p> : null}
          <div className="mt-3 rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
            <p className="text-muted text-xs font-semibold uppercase tracking-[0.12em]">Cert Summary</p>
            <p className="text-app mt-2 text-sm">{deterministicSummary}</p>
          </div>
        </section>
      ) : null}

      <section className="mt-4 rounded-[var(--radius-panel)] border-app border bg-surface/70 p-[var(--space-panel)]">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${activeTab === tab.key ? "btn-accent" : "btn-ghost"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "market" ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <ProceedsCalculator />
            <div className="grid gap-3">
              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
                <p className="text-muted text-xs font-semibold uppercase tracking-[0.12em]">Market Position</p>
                <p className="text-app mt-2 text-lg font-semibold">{marketPosition.label}</p>
                <p className="text-muted mt-1 text-sm">
                  Percent higher:{" "}
                  <span className="text-app font-semibold tabular-nums">
                    {marketPosition.percentHigher === null
                      ? "—"
                      : `${Number.isInteger(marketPosition.percentHigher)
                          ? marketPosition.percentHigher
                          : marketPosition.percentHigher.toFixed(1).replace(/\.0$/, "")}%`}
                  </span>
                </p>
              </div>

              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-muted text-xs font-semibold uppercase tracking-[0.12em]">Grade Pressure</p>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${pressureClass}`}>{supplyPressure.label}</span>
                </div>
                <p className="text-muted mt-2 text-sm">
                  {supplyPressure.ratio === null
                    ? "Share of graded copies that are higher than this grade is unavailable."
                    : supplyPressure.tone === "positive"
                      ? "Few higher-graded examples exist relative to total pop."
                      : supplyPressure.tone === "negative"
                        ? "Many higher-graded examples exist; this grade is supply-heavy."
                        : "Share of graded copies that are higher than this grade is moderate."}
                </p>
              </div>

              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-muted text-xs font-semibold uppercase tracking-[0.12em]">Liquidity Tier</p>
                  <span className="rounded-full border border-app bg-surface px-2 py-0.5 text-xs text-app">{liquidityTier}</span>
                </div>
                <p className="text-muted mt-2 text-sm">Derived from total graded population and current scarcity profile.</p>
              </div>

              <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
                <p className="text-muted text-xs font-semibold uppercase tracking-[0.12em]">Recent Sales (eBay)</p>
                <p className="text-muted mt-2 text-sm">No eBay comps connected yet.</p>
                <p className="text-muted mt-1 text-xs">
                  Once eBay access is enabled, this will show recent sold listings matched to this card/grade.
                </p>

                <div className="mt-3 rounded-[var(--radius-input)] border-app border bg-surface/70 p-2">
                  <div className="grid grid-cols-[0.8fr_0.8fr_2fr_0.8fr] gap-2 text-[11px] font-semibold text-muted">
                    <span>Date</span>
                    <span>Price</span>
                    <span>Title</span>
                    <span>Source</span>
                  </div>
                  <div className="mt-2 space-y-2">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className="grid grid-cols-[0.8fr_0.8fr_2fr_0.8fr] gap-2">
                        <span className="h-2 rounded bg-surface-soft" />
                        <span className="h-2 rounded bg-surface-soft" />
                        <span className="h-2 rounded bg-surface-soft" />
                        <span className="h-2 rounded bg-surface-soft" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "activity" ? (
          <div className="mt-4 rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
            {activityLoading ? <p className="text-muted text-sm">Loading activity…</p> : null}
            {!activityLoading && activityError ? <p className="text-negative text-sm">{activityError}</p> : null}
            {!activityLoading && !activityError && activityEvents.length === 0 ? (
              <p className="text-muted text-sm">No historical changes recorded yet.</p>
            ) : null}
            {!activityLoading && !activityError && activityEvents.length > 0 ? (
              <ol className="space-y-3">
                {activityEvents.map((event, index) => (
                  <li key={`${event.type}-${event.occurred_at}-${index}`} className="rounded-[var(--radius-card)] border-app border bg-surface/70 px-3 py-2">
                    <p className="text-app text-sm font-semibold">{event.summary}</p>
                    <p className="text-muted mt-1 text-xs">{formatTimestamp(event.occurred_at)}</p>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}

        {activeTab === "private" ? (
          <div className="mt-4 space-y-4">
            <PrivateSalesForm state={saleForm} onChange={setSaleForm} onSubmit={submitSale} submitting={saleSubmitting} />
            <PrivateSalesList
              sales={sales}
              loading={salesLoading}
              error={salesError}
              onRefresh={() => void loadPrivateSales()}
              onDelete={removeSale}
            />
            {saleToast ? <p className="text-muted text-xs">{saleToast}</p> : null}
          </div>
        ) : null}

        {activeTab === "raw" ? <RawJsonPanel value={rawLookup} className="mt-4" /> : null}
      </section>
    </section>
  );
}
