import { useState } from "react";
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

type TabKey = "overview" | "market" | "private" | "raw";

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

function StatCard({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="glass rounded-2xl border-app border p-4">
      <p className="text-muted text-xs font-semibold uppercase tracking-[0.14em]">{label}</p>
      <p className="text-app mt-2 text-4xl font-semibold tracking-tight">{value}</p>
      {sublabel ? <p className="text-muted mt-1 text-xs">{sublabel}</p> : null}
    </div>
  );
}

export default function CertDetailsCard({ cert, data, source, cacheHit, fetchedAt, rawLookup }: CertDetailsCardProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
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

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "market", label: "Market" },
    { key: "private", label: "Private Sales" },
    { key: "raw", label: "Raw Data" },
  ];

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
          <StatCard label="Rarity Insight" value={topGrade ? "Top Grade" : "Tiered"} sublabel={rarityMessage} />
          <StatCard label="Liquidity" value="—" sublabel="Private sale feed coming soon" />
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
          <div className="mt-4 rounded-2xl border-app border bg-surface-soft/55 p-4 text-sm text-muted">
            Market feed integration is UI-ready. Live transactions will appear here once connected.
          </div>
        ) : null}

        {activeTab === "private" ? (
          <div className="mt-4 rounded-2xl border-app border bg-surface-soft/55 p-4 text-sm text-muted">
            Private sales timeline is coming next. Use the “Add private sale” action to log manual transactions.
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
