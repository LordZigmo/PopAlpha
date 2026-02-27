import { createHash } from "node:crypto";
import type { CertificateResponse } from "@/lib/psa/client";

export type SnapshotParsed = {
  cert_no: string | null;
  year: number | null;
  set_name: string | null;
  subject: string | null;
  variety: string | null;
  grade: string | null;
  label: string | null;
  total_population: number | null;
  population_higher: number | null;
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeRawPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const payload = raw as Record<string, unknown>;
  const nested = payload.PSACert ?? payload.Result ?? payload.data;
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : payload;
}

function firstValue(payload: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = payload[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

export function buildSnapshotParsed(certData: CertificateResponse): SnapshotParsed {
  const raw = normalizeRawPayload(certData.raw);
  const totalPopulation = asFiniteNumber(firstValue(raw, ["TotalPopulation", "totalPopulation"]));
  const populationHigher = asFiniteNumber(firstValue(raw, ["PopulationHigher", "populationHigher"]));

  return {
    cert_no: certData.parsed.cert_no ?? null,
    year: certData.parsed.year ?? null,
    set_name: certData.parsed.set_name ?? asString(firstValue(raw, ["Brand", "Category", "set_name", "SetName"])),
    subject: certData.parsed.subject ?? asString(firstValue(raw, ["Subject", "subject"])),
    variety: certData.parsed.variety ?? asString(firstValue(raw, ["Variety", "variety"])),
    grade: certData.parsed.grade ?? asString(firstValue(raw, ["GradeDescription", "CardGrade", "Grade"])),
    label: certData.parsed.label ?? asString(firstValue(raw, ["LabelType", "Label", "label"])),
    total_population: totalPopulation,
    population_higher: populationHigher,
  };
}

export function hashSnapshotParsed(parsed: SnapshotParsed): string {
  const canonical = [
    parsed.year,
    parsed.set_name,
    parsed.subject,
    parsed.variety,
    parsed.grade,
    parsed.total_population,
    parsed.population_higher,
    parsed.label,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

