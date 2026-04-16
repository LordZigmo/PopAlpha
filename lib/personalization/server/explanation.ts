import "server-only";

import crypto from "node:crypto";

import { dbAdmin } from "@/lib/db/admin";

import { PROFILE_VERSION } from "../constants";
import { getPersonalizationCapability } from "../capability";
import {
  buildPersonalizedExplanation,
  type ExplanationCardInput,
} from "../explanation";
import type {
  Actor,
  CardStyleFeatures,
  PersonalizedExplanation,
  StyleProfile,
} from "../types";

function metricsHashFor(features: CardStyleFeatures): string {
  const payload = [
    features.era,
    features.release_year ?? "",
    features.is_graded ? "g" : "r",
    features.liquidity_band,
    features.volatility_band,
    features.is_iconic ? "1" : "0",
    features.is_art_centric ? "1" : "0",
    features.is_mainstream ? "1" : "0",
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

async function readCache(
  actor: Actor,
  canonicalSlug: string,
  profileVersion: number,
  metricsHash: string,
): Promise<PersonalizedExplanation | null> {
  try {
    const admin = dbAdmin();
    const { data, error } = await admin
      .from("personalization_explanation_cache")
      .select("payload")
      .eq("actor_key", actor.actor_key)
      .eq("canonical_slug", canonicalSlug)
      .eq("profile_version", profileVersion)
      .eq("metrics_hash", metricsHash)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.payload as PersonalizedExplanation;
  } catch {
    return null;
  }
}

async function writeCache(
  actor: Actor,
  canonicalSlug: string,
  profileVersion: number,
  metricsHash: string,
  payload: PersonalizedExplanation,
): Promise<void> {
  try {
    const admin = dbAdmin();
    await admin.from("personalization_explanation_cache").upsert(
      {
        actor_key: actor.actor_key,
        canonical_slug: canonicalSlug,
        profile_version: profileVersion,
        metrics_hash: metricsHash,
        payload,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "actor_key,canonical_slug,profile_version,metrics_hash" },
    );
  } catch (err) {
    console.error("[personalization:explanation] writeCache", err);
  }
}

/**
 * Get a personalized explanation for (actor, card). Honors the cache and
 * respects the capability mode (template vs. LLM).
 */
export async function getPersonalizedExplanation(
  actor: Actor,
  card: ExplanationCardInput,
  features: CardStyleFeatures,
  profile: StyleProfile | null,
): Promise<PersonalizedExplanation> {
  const capability = getPersonalizationCapability(actor);
  const profileVersion = profile?.version ?? PROFILE_VERSION;
  const metricsHash = metricsHashFor(features);

  const cached = await readCache(actor, card.canonical_slug, profileVersion, metricsHash);
  if (cached) return cached;

  const explanation = await buildPersonalizedExplanation(card, features, profile, capability);
  await writeCache(actor, card.canonical_slug, profileVersion, metricsHash, explanation);
  return explanation;
}
