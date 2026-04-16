import { NextResponse } from "next/server";

import { dbAdmin } from "@/lib/db/admin";

import {
  getCardStyleFeatures,
  type CardFeatureInput,
  type CardMetricsInput,
} from "@/lib/personalization/features/card-features";
import {
  resolveActor,
  setActorCookieOnResponse,
} from "@/lib/personalization/server/actor";
import { loadProfile } from "@/lib/personalization/server/recompute";
import { getPersonalizedExplanation } from "@/lib/personalization/server/explanation";
import { getPersonalizationCapability } from "@/lib/personalization/capability";
import type { ExplanationCardInput } from "@/lib/personalization/explanation";

export const runtime = "nodejs";

void dbAdmin;

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  year: number | null;
  card_number: string | null;
};

type MetricsRow = {
  canonical_slug: string;
  liquidity_score: number | null;
  volatility_30d: number | null;
  active_listings_7d: number | null;
};

type PrintingRow = {
  id: string;
  canonical_slug: string;
  rarity: string | null;
  finish: string | null;
};

function parseSlug(url: URL): string | null {
  const slug = url.searchParams.get("slug");
  if (!slug || typeof slug !== "string") return null;
  const trimmed = slug.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

function parseVariantRef(url: URL): string | null {
  const ref = url.searchParams.get("variant_ref");
  if (!ref || typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return trimmed;
}

function isGradedVariantRef(ref: string | null): boolean {
  if (!ref) return false;
  return /(::PSA|::CGC|::BGS|::TAG)/i.test(ref);
}

export async function GET(req: Request) {
  const actor = await resolveActor(req);
  const capability = getPersonalizationCapability(actor);

  if (!capability.enabled) {
    const response = NextResponse.json({ ok: true, enabled: false, explanation: null });
    if (actor.needs_cookie_set) setActorCookieOnResponse(response, actor.actor_key);
    return response;
  }

  const url = new URL(req.url);
  const slug = parseSlug(url);
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing slug." }, { status: 400 });
  }
  const variantRef = parseVariantRef(url);

  const admin = dbAdmin();

  const [canonicalRes, metricsRes, printingRes] = await Promise.all([
    admin
      .from("canonical_cards")
      .select("slug, canonical_name, set_name, year, card_number")
      .eq("slug", slug)
      .maybeSingle(),
    admin
      .from("public_card_metrics")
      .select("canonical_slug, liquidity_score, volatility_30d, active_listings_7d")
      .eq("canonical_slug", slug)
      .is("printing_id", null)
      .is("grade", null)
      .maybeSingle(),
    admin
      .from("card_printings")
      .select("id, canonical_slug, rarity, finish")
      .eq("canonical_slug", slug)
      .limit(20),
  ]);

  const canonical = canonicalRes.data as CanonicalRow | null;
  if (!canonical) {
    return NextResponse.json({ ok: false, error: "Card not found." }, { status: 404 });
  }
  const metrics = metricsRes.data as MetricsRow | null;
  const printings = (printingRes.data ?? []) as PrintingRow[];
  const pickedPrinting = printings.find((p) => p.rarity) ?? printings[0] ?? null;

  const cardInput: CardFeatureInput = {
    canonical_slug: slug,
    set_name: canonical.set_name ?? null,
    release_year: canonical.year ?? null,
    rarity: pickedPrinting?.rarity ?? null,
    card_number: canonical.card_number ?? null,
    finish: pickedPrinting?.finish ?? null,
    is_graded: isGradedVariantRef(variantRef),
  };
  const metricsInput: CardMetricsInput = {
    active_listings_7d: metrics?.active_listings_7d ?? null,
    liquidity_score: metrics?.liquidity_score ?? null,
    volatility_30d: metrics?.volatility_30d ?? null,
  };

  const features = getCardStyleFeatures(cardInput, metricsInput);
  const profile = await loadProfile(actor);

  const card: ExplanationCardInput = {
    canonical_slug: slug,
    canonical_name: canonical.canonical_name,
    set_name: canonical.set_name,
  };

  const explanation = await getPersonalizedExplanation(actor, card, features, profile);

  const response = NextResponse.json({
    ok: true,
    enabled: true,
    mode: capability.mode,
    explanation,
    profile_summary: profile
      ? {
          dominant_style_label: profile.dominant_style_label,
          supporting_traits: profile.supporting_traits,
          confidence: profile.confidence,
          event_count: profile.event_count,
        }
      : null,
  });
  if (actor.needs_cookie_set) setActorCookieOnResponse(response, actor.actor_key);
  return response;
}
