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

type CertDetailsCardProps = {
  cert: string;
  data: CertificateResponse;
  source?: string;
  cacheHit?: boolean;
  fetchedAt?: string;
  rawLookup: unknown;
};

type DisplayValue = string | number | null | undefined;
type TabKey = "overview" | "market" | "private" | "raw";

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

function dateToInput(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export default function CertDetailsCard({ cert, data, source, cacheHit, fetchedAt, rawLookup }: CertDetailsCardProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [sales, setSales] = useState<PrivateSale[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [saleToast, setSaleToast] = useState<string | null>(null);
  const [saleSubmitting, setSaleSubmitting] = useState(false);
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
  const totalPopulation = firstValue(rawPayload, ["TotalPopulation", "totalPopulation"]);
  const populationHigher = firstValue(rawPayload, ["PopulationHigher", "populationHigher"]);

  const metrics = useMemo(() => getDerivedMetrics(totalPopulation, populationHigher), [totalPopulation, populationHigher]);

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "overview", label: "Overview" },
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

  useEffect(() => {
    if (activeTab === "private") void loadPrivateSales();
  }, [activeTab, loadPrivateSales]);

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

  return (
    <section className="glass glow-card lift density-panel rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <article className="glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.18em]">Identity Hero</p>
              <p className="text-app mt-3 text-5xl font-semibold sm:text-6xl">{display(grade)}</p>
              <p className="text-app mt-3 text-base">{title}</p>
            </div>
            <div className="w-[11.5rem] shrink-0">
              <RarityRing score={metrics.scarcityScore} compact />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="border-app rounded-full border px-3 py-1">Cert #{cert}</span>
            <span className="border-app rounded-full border px-3 py-1">Category: {display(category)}</span>
            <span className="border-app rounded-full border px-3 py-1">Label: {display(labelType)}</span>
          </div>

          <div className="mt-4 text-xs text-muted">
            Source: {source === "cache" ? "cache" : "psa fresh"} · Cache: {cacheHit ? "hit" : "miss"} · Fetched: {fetchedAt ?? "—"}
          </div>
        </article>

        <aside className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <StatCard label="Total Pop" value={display(totalPopulation)} sublabel="Total graded examples" />
          <StatCard label="Population Higher" value={display(populationHigher)} sublabel="Examples in higher grades" />
          <StatCard
            label="Tier / Rarity"
            value={metrics.tierLabel}
            sublabel={metrics.topGrade ? "PopulationHigher = 0 (none higher)" : "Higher-grade examples exist"}
            highlight={metrics.topGrade}
            tierAccent
          />
          <StatCard
            label="Top Tier Share"
            value={metrics.topTierShare === null ? "—" : `${(metrics.topTierShare * 100).toFixed(1)}%`}
            sublabel="At grade or lower share"
          />
        </aside>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <RarityRing score={metrics.scarcityScore} />
        <PopulationBar higherShare={metrics.higherShare} topTierShare={metrics.topTierShare} />
      </div>

      <section className="mt-5 rounded-[var(--radius-panel)] border-app border bg-surface/70 p-[var(--space-panel)]">
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

        {activeTab === "overview" ? (
          <div className="mt-4 rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)] text-sm text-muted">
            <p>
              This profile has <span className="text-app font-semibold">{display(totalPopulation)}</span> total graded examples, with{" "}
              <span className="text-app font-semibold">{display(populationHigher)}</span> graded higher.
            </p>
            <p className="mt-2">
              Tier status: <span className="text-app font-semibold">{metrics.tierLabel}</span>. Scarcity Index:{" "}
              <span className="text-app font-semibold">{metrics.scarcityScore ?? "—"}</span>.
            </p>
          </div>
        ) : null}

        {activeTab === "market" ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <ProceedsCalculator />
            <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
              <p className="text-app text-sm font-semibold">Market Context</p>
              <div className="mt-3 space-y-2 text-sm">
                <p className="text-muted">
                  Fair Value: <span className="font-semibold">—</span> <span className="text-xs">(coming soon)</span>
                </p>
                <p className="text-muted">
                  Volatility: <span className="font-semibold">—</span> <span className="text-xs">(coming soon)</span>
                </p>
                <p className="text-muted">
                  Avg days to sell: <span className="font-semibold">—</span> <span className="text-xs">(coming soon)</span>
                </p>
              </div>
            </div>
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
