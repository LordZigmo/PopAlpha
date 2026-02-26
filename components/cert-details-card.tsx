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
  return String(value);
}

function SourceBadge({ source, cacheHit, fetchedAt }: { source?: string; cacheHit?: boolean; fetchedAt?: string }) {
  const sourceText = source === "cache" ? "cache" : "psa";

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
      <span className="rounded-full border border-neutral-300/80 bg-neutral-100/80 px-2.5 py-1 font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-200">
        Source: {sourceText}
      </span>
      <span className="rounded-full border border-neutral-300/80 bg-neutral-100/80 px-2.5 py-1 font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-200">
        cache_hit: {cacheHit ? "true" : "false"}
      </span>
      <span className="rounded-full border border-neutral-300/80 bg-neutral-100/80 px-2.5 py-1 font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-200">
        fetched_at: {formatDate(fetchedAt)}
      </span>
    </div>
  );
}

export default function CertDetailsCard({ cert, data, source, cacheHit, fetchedAt }: CertDetailsCardProps) {
  const rawPayload = normalizeRaw(data.raw);

  const grade = firstValue(rawPayload, ["GradeDescription", "CardGrade", "grade", "Grade", "Card Grade"]) ?? data.parsed.grade;
  const year = firstValue(rawPayload, ["Year", "year"]) ?? data.parsed.year;
  const brand = firstValue(rawPayload, ["Brand", "brand"]);
  const setSignal = [
    firstValue(rawPayload, ["Subject", "subject"]) ?? data.parsed.subject,
    firstValue(rawPayload, ["Variety", "variety"]) ?? data.parsed.variety,
  ]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
    .map((value) => String(value));
  const brandSet = [display(brand) === "—" ? null : display(brand), ...setSignal]
    .filter((value) => value && value !== "—")
    .join(" • ");

  const category = firstValue(rawPayload, ["Category", "category", "Sport"]) ?? data.parsed.label;
  const totalPopulation = firstValue(rawPayload, ["TotalPopulation", "totalPopulation"]);
  const populationHigher = firstValue(rawPayload, ["PopulationHigher", "populationHigher"]);
  const imageUrl = firstValue(rawPayload, ["ImageURL", "imageUrl", "image_url"]) ?? data.parsed.image_url;

  return (
    <section className="card rounded-2xl p-5 sm:p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Cert Details</h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
            A quick summary of the most useful certificate fields.
          </p>
        </div>

        <SourceBadge source={source} cacheHit={cacheHit} fetchedAt={fetchedAt} />

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px] sm:items-start">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Cert #</dt>
              <dd className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100">{cert}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Grade</dt>
              <dd className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100">{display(grade)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Year</dt>
              <dd className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100">{display(year)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Brand / Set</dt>
              <dd className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100">{brandSet || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Category</dt>
              <dd className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100">{display(category)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Population</dt>
              <dd className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100">
                Total {display(totalPopulation)} · Higher {display(populationHigher)}
              </dd>
            </div>
          </dl>

          {typeof imageUrl === "string" && imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={`PSA cert ${cert} thumbnail`}
              className="h-28 w-28 rounded-lg border border-neutral-300/80 object-cover dark:border-neutral-700"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
