import type { CertificateResponse } from "@/lib/psa/client";

type CertDetailsCardProps = {
  cert: string;
  data: CertificateResponse;
  source?: string;
  cacheHit?: boolean;
  fetchedAt?: string;
};

type DisplayValue = string | number | null | undefined;

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
    <div className="border-app bg-surface rounded-2xl border p-4">
      <p className="text-muted text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-app">{value}</p>
      {sublabel ? <p className="text-muted mt-1 text-xs">{sublabel}</p> : null}
    </div>
  );
}

export default function CertDetailsCard({ cert, data, source, cacheHit, fetchedAt }: CertDetailsCardProps) {
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

  const titleParts = [display(year), display(subject), display(variety), display(brand)].filter((value) => value !== "—");
  const title = titleParts.length > 0 ? titleParts.join(" — ") : "Unspecified listing";

  const higherCount = toNumber(populationHigher);
  const totalCount = toNumber(totalPopulation);
  const topGrade = higherCount === 0;

  return (
    <section className="card glow-card lift rounded-3xl p-6 sm:p-7">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-muted text-xs font-semibold uppercase tracking-[0.18em]">Grade</p>
              <p className="text-app mt-2 text-5xl font-semibold tracking-tight sm:text-6xl">{display(grade)}</p>
              <p className="text-app mt-3 text-base">{title}</p>
              <p className="text-muted mt-1 text-sm">Cert #{cert}</p>
            </div>

            {typeof imageUrl === "string" && imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={`PSA cert ${cert} thumbnail`}
                className="border-app h-24 w-24 rounded-xl border object-cover shadow-sm"
              />
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="border-app bg-surface-soft text-app rounded-full border px-3 py-1 text-xs font-medium">
              Category: {display(category)}
            </span>
            <span className="border-app bg-surface-soft text-app rounded-full border px-3 py-1 text-xs font-medium">
              Label: {display(labelType)}
            </span>
          </div>

          <div className="border-app bg-surface rounded-2xl border p-4">
            <p className="text-muted text-xs font-medium uppercase tracking-[0.14em]">Provenance</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs sm:text-sm">
              <span className="border-app bg-surface-soft text-app rounded-full border px-2.5 py-1 font-medium">
                Source: {source === "cache" ? "cache" : "psa fresh"}
              </span>
              <span className="border-app bg-surface-soft text-app rounded-full border px-2.5 py-1 font-medium">
                Cache hit: {cacheHit ? "true" : "false"}
              </span>
              <span className="border-app bg-surface-soft text-app rounded-full border px-2.5 py-1 font-medium">
                Fetched: {formatDate(fetchedAt)}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <StatCard label="Total Population" value={display(totalPopulation)} sublabel="Total graded examples" />
          <StatCard label="Higher Population" value={display(populationHigher)} sublabel="Examples above this grade" />
          <div className="border-app bg-surface rounded-2xl border p-4">
            <p className="text-muted text-xs font-medium uppercase tracking-wide">Rarity Insight</p>
            <p
              className={`mt-3 inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${
                topGrade
                  ? "badge-positive"
                  : "border-app bg-surface-soft text-app"
              }`}
            >
              {topGrade ? "Top grade / None higher" : `Higher: ${display(populationHigher)}`}
            </p>
            {topGrade && totalCount !== null ? (
              <p className="text-positive mt-2 text-xs">This cert sits at the highest recorded PSA tier.</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
