import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { getRequiredEnv } from "@/lib/env";

export const runtime = "nodejs";

type InputPrinting = {
  canonical_slug?: unknown;
  set_name?: unknown;
  set_code?: unknown;
  year?: unknown;
  card_number?: unknown;
  language?: unknown;
  finish?: unknown;
  finish_detail?: unknown;
  edition?: unknown;
  stamp?: unknown;
  rarity?: unknown;
  image_url?: unknown;
  source?: unknown;
  source_id?: unknown;
  aliases?: unknown;
};

const VALID_FINISH = new Set(["NON_HOLO", "HOLO", "REVERSE_HOLO", "ALT_HOLO", "UNKNOWN"]);
const VALID_EDITION = new Set(["UNLIMITED", "FIRST_EDITION", "UNKNOWN"]);

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toRequiredString(value: unknown): string | null {
  const next = toOptionalString(value);
  return next ?? null;
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";

  let adminSecret: string;
  try {
    adminSecret = getRequiredEnv("ADMIN_SECRET");
  } catch {
    return NextResponse.json({ ok: false, error: "Missing ADMIN_SECRET env var (server-only)." }, { status: 500 });
  }

  if (auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!Array.isArray(payload)) {
    return NextResponse.json({ ok: false, error: "Body must be a JSON array of printings." }, { status: 400 });
  }

  const supabase = getServerSupabaseClient();
  const rejects: Array<{ index: number; reason: string }> = [];
  let inserted = 0;
  let updated = 0;
  let aliasesUpserted = 0;

  for (let index = 0; index < payload.length; index += 1) {
    const raw = payload[index] as InputPrinting;
    const canonicalSlug = toRequiredString(raw.canonical_slug);
    const cardNumber = toRequiredString(raw.card_number);
    const language = toRequiredString(raw.language)?.toUpperCase() ?? null;
    const finish = toRequiredString(raw.finish)?.toUpperCase() ?? null;
    const edition = toRequiredString(raw.edition)?.toUpperCase() ?? null;
    const source = toRequiredString(raw.source);

    if (!canonicalSlug || !cardNumber || !language || !finish || !edition || !source) {
      rejects.push({ index, reason: "Missing required field(s): canonical_slug, card_number, language, finish, edition, source." });
      continue;
    }
    if (!VALID_FINISH.has(finish)) {
      rejects.push({ index, reason: `Invalid finish '${finish}'.` });
      continue;
    }
    if (!VALID_EDITION.has(edition)) {
      rejects.push({ index, reason: `Invalid edition '${edition}'.` });
      continue;
    }

    const year = typeof raw.year === "number" && Number.isFinite(raw.year) ? Math.round(raw.year) : null;
    const setName = toOptionalString(raw.set_name);
    const setCode = toOptionalString(raw.set_code)?.toUpperCase() ?? null;
    const finishDetail = toOptionalString(raw.finish_detail);
    const stamp = toOptionalString(raw.stamp);
    const rarity = toOptionalString(raw.rarity);
    const imageUrl = toOptionalString(raw.image_url);
    const sourceId = toOptionalString(raw.source_id);
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.map((alias) => (typeof alias === "string" ? normalizeAlias(alias) : "")).filter((alias) => alias.length > 0)
      : [];

    let existingQuery = supabase
      .from("card_printings")
      .select("id")
      .eq("card_number", cardNumber)
      .eq("language", language)
      .eq("finish", finish)
      .eq("edition", edition);
    existingQuery = setCode ? existingQuery.eq("set_code", setCode) : existingQuery.is("set_code", null);
    existingQuery = stamp ? existingQuery.eq("stamp", stamp) : existingQuery.is("stamp", null);
    existingQuery = finishDetail
      ? existingQuery.eq("finish_detail", finishDetail)
      : existingQuery.is("finish_detail", null);

    const { data: existingData, error: existingError } = await existingQuery
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (existingError) {
      rejects.push({ index, reason: existingError.message });
      continue;
    }

    let printingId: string;
    if (existingData?.id) {
      printingId = existingData.id;
      const { error: updateError } = await supabase
        .from("card_printings")
        .update({
          canonical_slug: canonicalSlug,
          set_name: setName,
          set_code: setCode,
          year,
          card_number: cardNumber,
          language,
          finish,
          finish_detail: finishDetail,
          edition,
          stamp,
          rarity,
          image_url: imageUrl,
          source,
          source_id: sourceId,
        })
        .eq("id", printingId);
      if (updateError) {
        rejects.push({ index, reason: updateError.message });
        continue;
      }
      updated += 1;
    } else {
      const { data: insertedRow, error: insertError } = await supabase
        .from("card_printings")
        .insert({
          canonical_slug: canonicalSlug,
          set_name: setName,
          set_code: setCode,
          year,
          card_number: cardNumber,
          language,
          finish,
          finish_detail: finishDetail,
          edition,
          stamp,
          rarity,
          image_url: imageUrl,
          source,
          source_id: sourceId,
        })
        .select("id")
        .single<{ id: string }>();
      if (insertError || !insertedRow) {
        rejects.push({ index, reason: insertError?.message ?? "Insert failed." });
        continue;
      }
      printingId = insertedRow.id;
      inserted += 1;
    }

    if (aliases.length > 0) {
      const aliasRows = aliases.map((alias) => ({
        alias,
        printing_id: printingId,
      }));
      const { error: aliasError } = await supabase
        .from("printing_aliases")
        .upsert(aliasRows, { onConflict: "alias" });
      if (aliasError) {
        rejects.push({ index, reason: `Alias upsert failed: ${aliasError.message}` });
        continue;
      }
      aliasesUpserted += aliasRows.length;
    }
  }

  return NextResponse.json({
    ok: true,
    received: payload.length,
    inserted,
    updated,
    aliases_upserted: aliasesUpserted,
    rejected_count: rejects.length,
    rejects,
  });
}
