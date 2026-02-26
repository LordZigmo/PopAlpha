import { useCallback, useEffect, useMemo, useState } from "react";
import type { CertificateResponse } from "@/lib/psa/client";
import RawJsonPanel from "@/components/raw-json-panel";

type CertDetailsCardProps = {
  cert: string;
  data: CertificateResponse;
  source?: string;
  cacheHit?: boolean;
  fetchedAt?: string;
  rawLookup: unknown;
};

type DisplayValue = string | number | null | undefined;
type PrivateSale = {
  id: string;
  cert: string;
  price: number;
  currency: string;
  sold_at: string;
  fees: number | null;
  notes: string | null;
  created_at: string;
};

function normalizeRaw(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};

  const payload = raw as Record<string, unknown>;
  const psaCert = payload.PSACert;
  if (psaCert && typeof psaCert === "object") {
    return psaCert as Record<string, unknown>;
  }

  const result = payload.Result;
  if (result && typeof result === "object") {
    return result as Record<string, unknown>;
  }

  const data = payload.data;
  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }

  return payload;
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

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDateInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function display(value: DisplayValue): string {
  if (value === null || value === undefined) return "—";
  const next = String(value).trim();
  return next === "" ? "—" : next;
}

function toNumber(value: DisplayValue): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function StatCard({
  label,
  value,
  sublabel,
  highlight,
}: {
  label: string;
  value: string;
  sublabel?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`glass rounded-2xl border p-4 ${
        highlight ? "border-emerald-500/20 bg-emerald-500/10" : "border-app"
      }`}
    >
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">{label}</p>
      <p className={`mt-2 text-4xl font-semibold tracking-tight ${highlight ? "text-positive" : "text-app"}`}>{value}</p>
      {sublabel ? <p className="text-muted mt-1 text-xs">{sublabel}</p> : null}
    </div>
  );
}

export default function CertDetailsCard({ cert, data, source, cacheHit, fetchedAt, rawLookup }: CertDetailsCardProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "market" | "private" | "raw">("overview");
  const [sales, setSales] = useState<PrivateSale[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [saleDate, setSaleDate] = useState(formatDateInputValue(new Date().toISOString()));
  const [salePrice, setSalePrice] = useState("");
  const [saleFees, setSaleFees] = useState("");
  const [saleNotes, setSaleNotes] = useState("");
  const [saleSubmitting, setSaleSubmitting] = useState(false);
  const [saleToast, setSaleToast] = useState<string | null>(null);

  const [offerPrice, setOfferPrice] = useState("");
  const [paymentFeePct, setPaymentFeePct] = useState("0");
  const [ebayFeePct, setEbayFeePct] = useState("13.25");

  const rawPayload = normalizeRaw(data.raw);

  const grade = data.parsed.grade ?? firstValue(rawPayload, ["GradeDescription", "CardGrade", "grade", "Grade", "Card Grade"]);
  const year = data.parsed.year ?? firstValue(rawPayload, ["Year", "year"]);
  const brand = firstValue(rawPayload, ["Brand", "brand"]);
  const subject = data.parsed.subject ?? firstValue(rawPayload, ["Subject", "subject"]);
  const variety = data.parsed.variety ?? firstValue(rawPayload, ["Variety", "variety"]);
  const category = firstValue(rawPayload, ["Category", "category", "Sport"]);
  const labelType = data.parsed.label ?? firstValue(rawPayload, ["LabelType", "label", "Label", "certLabel"]);
  const totalPopulation = firstValue(rawPayload, ["TotalPopulation", "totalPopulation"]);
  const populationHigher = firstValue(rawPayload, ["PopulationHigher", "populationHigher"]);
  const imageUrl = firstValue(rawPayload, ["ImageURL", "imageUrl", "image_url"]) ?? data.parsed.image_url;

  const titleParts = [display(year), display(brand), display(subject), display(variety)].filter((value) => value !== "—");
  const title = titleParts.length > 0 ? titleParts.join(" • ") : "Unspecified listing";

  const higherCount = toNumber(populationHigher);
  const totalCount = toNumber(totalPopulation);
  const topGrade = higherCount === 0;

  const rarityMessage = topGrade
    ? "Top grade — no higher examples recorded."
    : higherCount !== null
      ? `${higherCount.toLocaleString()} copies sit above this grade.`
      : "Higher population data unavailable.";

  const tabs: Array<{ key: "overview" | "market" | "private" | "raw"; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "market", label: "Market" },
    { key: "private", label: "Private Sales" },
    { key: "raw", label: "Raw Data" },
  ];

  const loadPrivateSales = useCallback(async () => {
    setSalesLoading(true);
    setSalesError(null);

    try {
      const response = await fetch(`/api/private-sales?cert=${encodeURIComponent(cert)}`, { method: "GET" });
      const payload = (await response.json()) as { ok: boolean; sales?: PrivateSale[]; error?: string };
      if (!response.ok || !payload.ok) {
        setSalesError(payload.error ?? "Failed to load private sales.");
        setSales([]);
        return;
      }

      setSales(payload.sales ?? []);
    } catch (error) {
      setSalesError(String(error));
      setSales([]);
    } finally {
      setSalesLoading(false);
    }
  }, [cert]);

  useEffect(() => {
    if (activeTab !== "private") return;
    void loadPrivateSales();
  }, [activeTab, loadPrivateSales]);

  useEffect(() => {
    if (!saleToast) return;
    const timer = window.setTimeout(() => setSaleToast(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saleToast]);

  async function addPrivateSale() {
    const price = Number(salePrice);
    const fees = saleFees.trim() === "" ? null : Number(saleFees);

    if (!saleDate) {
      setSaleToast("Please choose a sale date.");
      return;
    }

    if (!Number.isFinite(price) || price <= 0) {
      setSaleToast("Please enter a valid positive sale price.");
      return;
    }

    if (fees !== null && (!Number.isFinite(fees) || fees < 0)) {
      setSaleToast("Fees must be empty or a non-negative number.");
      return;
    }

    setSaleSubmitting(true);

    try {
      const response = await fetch("/api/private-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cert,
          price,
          sold_at: new Date(`${saleDate}T12:00:00.000Z`).toISOString(),
          fees,
          notes: saleNotes.trim() || null,
        }),
      });

      const payload = (await response.json()) as { ok: boolean; sale?: PrivateSale; error?: string };
      if (!response.ok || !payload.ok || !payload.sale) {
        setSaleToast(payload.error ?? "Failed to save private sale.");
        return;
      }

      setSales((prev) => [payload.sale as PrivateSale, ...prev]);
      setSalePrice("");
      setSaleFees("");
      setSaleNotes("");
      setSaleToast("Private sale saved.");
    } catch (error) {
      setSaleToast(String(error));
    } finally {
      setSaleSubmitting(false);
    }
  }

  const marketCalc = useMemo(() => {
    const offer = Number(offerPrice);
    const privateFee = Number(paymentFeePct);
    const ebayFee = Number(ebayFeePct);

    if (!Number.isFinite(offer) || offer <= 0) {
      return {
        privateNet: null,
        ebayNet: null,
        difference: null,
        recommendation: "Enter an offer price to compare net proceeds.",
      };
    }

    const safePrivateFee = Number.isFinite(privateFee) ? Math.max(0, privateFee) : 0;
    const safeEbayFee = Number.isFinite(ebayFee) ? Math.max(0, ebayFee) : 13.25;

    const privateNet = offer * (1 - safePrivateFee / 100);
    const ebayNet = offer * (1 - safeEbayFee / 100);
    const difference = privateNet - ebayNet;

    const threshold = 10;
    const recommendation =
      difference > threshold
        ? "Private sale looks better after fees."
        : difference < -threshold
          ? "eBay looks better after fees."
          : "Both options are close after fees.";

    return { privateNet, ebayNet, difference, recommendation };
  }, [offerPrice, paymentFeePct, ebayFeePct]);

  return (
    <section className="glass glow-card lift rounded-[1.75rem] border-app border p-4 sm:p-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <article className="glass rounded-3xl border-app border p-5">
          <p className="text-muted text-xs font-semibold uppercase tracking-[0.18em]">Identity Hero</p>
          <p className="text-app mt-3 text-6xl font-semibold leading-none tracking-tight sm:text-7xl">{display(grade)}</p>
          <p className="text-app mt-3 text-base sm:text-lg">{title}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <span className="border-app bg-surface-soft text-app rounded-full border px-3 py-1 text-xs font-medium">Cert #{cert}</span>
            <span className="border-app bg-surface-soft text-app rounded-full border px-3 py-1 text-xs font-medium">Category: {display(category)}</span>
            <span className="border-app bg-surface-soft text-app rounded-full border px-3 py-1 text-xs font-medium">Label: {display(labelType)}</span>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
            {typeof imageUrl === "string" && imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`PSA cert ${cert} thumbnail`}
                className="h-28 w-28 rounded-2xl border-app border object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-2xl border-app border bg-surface-soft text-3xl" aria-label="No image available">
                🪪
              </div>
            )}
            <div className="rounded-2xl border-app border bg-surface p-4">
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">Provenance</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="border-app bg-surface-soft text-app rounded-full border px-2.5 py-1 font-medium">
                  Source: {source === "cache" ? "cache" : "psa fresh"}
                </span>
                <span className="border-app bg-surface-soft text-app rounded-full border px-2.5 py-1 font-medium">
                  Cache: {cacheHit ? "hit" : "miss"}
                </span>
                <span className="border-app bg-surface-soft text-app rounded-full border px-2.5 py-1 font-medium">
                  Fetched: {formatDate(fetchedAt)}
                </span>
              </div>
            </div>
          </div>
        </article>

        <aside className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <StatCard label="Total Pop" value={display(totalPopulation)} sublabel="Total graded examples" />
          <StatCard label="Higher Pop" value={display(populationHigher)} sublabel="Examples above this grade" />
          <StatCard label="Rarity Insight" value={topGrade ? "Top Grade" : "Tiered"} sublabel={rarityMessage} highlight={topGrade} />
          <StatCard label="Liquidity" value="—" sublabel="Private sale feed now in tab below" />
        </aside>
      </div>

      <section className="mt-5 rounded-3xl border-app border bg-surface/70 p-4 sm:p-5">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${
                activeTab === tab.key ? "btn-accent" : "btn-ghost"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "overview" ? (
          <div className="mt-4 rounded-2xl border-app border bg-surface-soft/55 p-4">
            <p className="text-app text-sm font-semibold">Market Activity Summary</p>
            <p className="text-muted mt-2 text-sm">
              This cert currently has a total population of <span className="text-app font-semibold">{display(totalPopulation)}</span> with
              <span className="text-app font-semibold"> {display(populationHigher)}</span> graded higher. Rarity status: <span className="text-app font-semibold">{rarityMessage}</span>
            </p>
          </div>
        ) : null}

        {activeTab === "market" ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border-app border bg-surface-soft/55 p-4">
              <p className="text-app text-sm font-semibold">Net Proceeds Calculator</p>
              <div className="mt-3 space-y-3">
                <label className="block">
                  <span className="text-muted text-xs">Offer price</span>
                  <input value={offerPrice} onChange={(event) => setOfferPrice(event.target.value)} className="input-themed mt-1 h-10 w-full rounded-xl px-3 text-sm" placeholder="1000" />
                </label>
                <label className="block">
                  <span className="text-muted text-xs">Private payment fee % (optional)</span>
                  <input value={paymentFeePct} onChange={(event) => setPaymentFeePct(event.target.value)} className="input-themed mt-1 h-10 w-full rounded-xl px-3 text-sm" placeholder="0" />
                </label>
                <label className="block">
                  <span className="text-muted text-xs">eBay fee %</span>
                  <input value={ebayFeePct} onChange={(event) => setEbayFeePct(event.target.value)} className="input-themed mt-1 h-10 w-full rounded-xl px-3 text-sm" placeholder="13.25" />
                </label>
              </div>
            </div>

            <div className="rounded-2xl border-app border bg-surface-soft/55 p-4">
              <p className="text-muted text-xs uppercase tracking-[0.14em]">Comparison</p>
              <p className="text-app mt-3 text-sm">Private net: <span className="font-semibold">{marketCalc.privateNet === null ? "—" : `$${marketCalc.privateNet.toFixed(2)}`}</span></p>
              <p className="text-app mt-1 text-sm">eBay net: <span className="font-semibold">{marketCalc.ebayNet === null ? "—" : `$${marketCalc.ebayNet.toFixed(2)}`}</span></p>
              <p className="text-app mt-1 text-sm">Difference: <span className="font-semibold">{marketCalc.difference === null ? "—" : `$${marketCalc.difference.toFixed(2)}`}</span></p>
              <p className="text-muted mt-3 text-sm">{marketCalc.recommendation}</p>
            </div>
          </div>
        ) : null}

        {activeTab === "private" ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border-app border bg-surface-soft/55 p-4">
              <p className="text-app text-sm font-semibold">Add Private Sale</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-muted text-xs">Sold date</span>
                  <input type="date" value={saleDate} onChange={(event) => setSaleDate(event.target.value)} className="input-themed mt-1 h-10 w-full rounded-xl px-3 text-sm" />
                </label>
                <label className="block">
                  <span className="text-muted text-xs">Price (USD)</span>
                  <input value={salePrice} onChange={(event) => setSalePrice(event.target.value)} className="input-themed mt-1 h-10 w-full rounded-xl px-3 text-sm" placeholder="500" />
                </label>
                <label className="block">
                  <span className="text-muted text-xs">Fees (optional)</span>
                  <input value={saleFees} onChange={(event) => setSaleFees(event.target.value)} className="input-themed mt-1 h-10 w-full rounded-xl px-3 text-sm" placeholder="20" />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-muted text-xs">Notes (optional)</span>
                  <textarea value={saleNotes} onChange={(event) => setSaleNotes(event.target.value)} className="input-themed mt-1 min-h-20 w-full rounded-xl px-3 py-2 text-sm" placeholder="Auction house, buyer note, etc." />
                </label>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button type="button" onClick={addPrivateSale} disabled={saleSubmitting} className="btn-accent rounded-xl px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55">
                  {saleSubmitting ? "Saving..." : "Save Private Sale"}
                </button>
                {saleToast ? <span className="text-muted text-xs">{saleToast}</span> : null}
              </div>
            </div>

            <div className="rounded-2xl border-app border bg-surface-soft/55 p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-app text-sm font-semibold">Sales for cert #{cert}</p>
                <button type="button" className="btn-ghost rounded-xl px-3 py-1 text-xs" onClick={() => void loadPrivateSales()}>
                  Refresh
                </button>
              </div>

              {salesLoading ? <p className="text-muted text-sm">Loading private sales…</p> : null}
              {salesError ? <p className="text-negative text-sm">{salesError}</p> : null}

              {!salesLoading && !salesError && sales.length === 0 ? (
                <p className="text-muted text-sm">No private sales yet for this cert. Add your first sale above.</p>
              ) : null}

              {!salesLoading && !salesError && sales.length > 0 ? (
                <ul className="space-y-2">
                  {sales.map((sale) => (
                    <li key={sale.id} className="rounded-xl border-app border bg-surface p-3 text-sm">
                      <p className="text-app font-semibold">${Number(sale.price).toFixed(2)} <span className="text-muted font-normal">({sale.currency})</span></p>
                      <p className="text-muted mt-1">Sold: {formatDate(sale.sold_at)}</p>
                      <p className="text-muted">Fees: {sale.fees === null ? "—" : `$${Number(sale.fees).toFixed(2)}`}</p>
                      {sale.notes ? <p className="text-muted">Notes: {sale.notes}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === "raw" ? <RawJsonPanel value={rawLookup} className="mt-4" /> : null}
      </section>

      {topGrade && totalCount !== null ? (
        <p className="badge-positive mt-4 inline-flex rounded-full px-3 py-1 text-xs font-semibold">
          Top grade status confirmed for this cert.
        </p>
      ) : null}
    </section>
  );
}
