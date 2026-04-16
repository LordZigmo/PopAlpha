import "server-only";

import type { Actor, BehaviorEvent } from "../types";
import { ingestEvents } from "./ingest";

export type PersonaKey =
  | "nostalgia_driven"
  | "modern_momentum"
  | "set_completionist"
  | "art_first"
  | "liquidity_conscious";

export const PERSONA_LABELS: Record<PersonaKey, string> = {
  nostalgia_driven: "Nostalgia-driven",
  modern_momentum: "Modern momentum",
  set_completionist: "Set completionist",
  art_first: "Art-first",
  liquidity_conscious: "Liquidity-conscious",
};

/**
 * Slugs used by persona seeds. These are generic, well-known canonical-style
 * slug shapes — they do NOT need to exist in the canonical_cards table.
 * The behavior events simply reference them as strings; the recompute step
 * will gracefully return null features for unknown slugs, so seed data still
 * scores correctly via event-level signal (variant_switch, expand events).
 *
 * For best results in a real environment, the seed should reference real
 * canonical slugs; but for standalone dev smoke tests the generic slugs below
 * exercise the full pipeline end-to-end.
 */
type PersonaTemplate = {
  label: string;
  events: Array<{
    event_type: BehaviorEvent["event_type"];
    canonical_slug: string | null;
    variant_ref: string | null;
    /** Hours ago. */
    ago_hours: number;
  }>;
};

function viewSequence(
  slugs: string[],
  offset = 0,
  spacingHours = 2,
): PersonaTemplate["events"] {
  return slugs.map((slug, i) => ({
    event_type: "card_view" as const,
    canonical_slug: slug,
    variant_ref: null,
    ago_hours: offset + i * spacingHours,
  }));
}

const PERSONA_TEMPLATES: Record<PersonaKey, PersonaTemplate> = {
  nostalgia_driven: {
    label: "Nostalgia-driven",
    events: [
      ...viewSequence([
        "charizard-base-set-4",
        "blastoise-base-set-2",
        "venusaur-base-set-15",
        "pikachu-base-set-58",
        "charizard-base-set-4",
        "mewtwo-base-set-10",
        "dragonite-fossil-4",
        "charizard-base-set-4",
        "pikachu-base-set-58",
        "mew-promo-8",
      ]),
      { event_type: "market_signal_expand", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 1 },
      { event_type: "price_history_expand", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 0.5 },
      { event_type: "watchlist_add", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 0.2 },
      { event_type: "ai_analysis_expand", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 0.1 },
    ],
  },
  modern_momentum: {
    label: "Modern momentum",
    events: [
      ...viewSequence([
        "charizard-ex-obsidian-flames-125",
        "charizard-ex-obsidian-flames-215",
        "pikachu-vmax-rainbow-188",
        "charizard-ex-obsidian-flames-215",
        "umbreon-vmax-alt-art-215",
        "giratina-v-alt-215",
        "charizard-ex-obsidian-flames-215",
      ]),
      { event_type: "price_history_expand", canonical_slug: "umbreon-vmax-alt-art-215", variant_ref: null, ago_hours: 1.5 },
      { event_type: "price_history_expand", canonical_slug: "charizard-ex-obsidian-flames-215", variant_ref: null, ago_hours: 1 },
      { event_type: "market_signal_expand", canonical_slug: "charizard-ex-obsidian-flames-215", variant_ref: null, ago_hours: 0.5 },
      { event_type: "compare_open", canonical_slug: "charizard-ex-obsidian-flames-215", variant_ref: null, ago_hours: 0.2 },
    ],
  },
  set_completionist: {
    label: "Set completionist",
    events: [
      ...viewSequence([
        "charizard-base-set-4",
        "blastoise-base-set-2",
        "venusaur-base-set-15",
        "pikachu-base-set-58",
        "mewtwo-base-set-10",
        "chansey-base-set-3",
        "clefairy-base-set-5",
        "gyarados-base-set-6",
        "hitmonchan-base-set-7",
        "machamp-base-set-8",
        "magneton-base-set-9",
      ]),
    ],
  },
  art_first: {
    label: "Art-first",
    events: [
      ...viewSequence([
        "umbreon-vmax-alt-art-215",
        "giratina-v-alt-215",
        "mew-vmax-alt-210",
        "rayquaza-vmax-alt-218",
        "charizard-ex-sir-obsidian-215",
        "umbreon-vmax-alt-art-215",
      ]),
      { event_type: "ai_analysis_expand", canonical_slug: "umbreon-vmax-alt-art-215", variant_ref: null, ago_hours: 1 },
      { event_type: "watchlist_add", canonical_slug: "umbreon-vmax-alt-art-215", variant_ref: null, ago_hours: 0.5 },
    ],
  },
  liquidity_conscious: {
    label: "Liquidity-conscious",
    events: [
      ...viewSequence([
        "charizard-base-set-4",
        "pikachu-base-set-58",
        "charizard-ex-obsidian-flames-125",
        "pikachu-vmax-rainbow-188",
        "charizard-base-set-4",
      ]),
      { event_type: "compare_open", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 0.5 },
      { event_type: "market_signal_expand", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 0.3 },
      { event_type: "variant_switch", canonical_slug: "charizard-base-set-4", variant_ref: "p1::PSA::G10", ago_hours: 0.4 },
      { event_type: "variant_switch", canonical_slug: "charizard-base-set-4", variant_ref: "p1::PSA::G9", ago_hours: 0.3 },
      { event_type: "ai_analysis_expand", canonical_slug: "charizard-base-set-4", variant_ref: null, ago_hours: 0.1 },
    ],
  },
};

function materialize(template: PersonaTemplate): BehaviorEvent[] {
  const now = Date.now();
  return template.events.map((e) => ({
    event_type: e.event_type,
    canonical_slug: e.canonical_slug,
    printing_id: null,
    variant_ref: e.variant_ref,
    occurred_at: new Date(now - e.ago_hours * 60 * 60 * 1000).toISOString(),
    payload: { seed: true },
  }));
}

/**
 * Insert a persona-shaped event stream for the given actor.
 * Used only by the dev debug surface.
 */
export async function seedPersonaEvents(
  actor: Actor,
  persona: PersonaKey,
): Promise<{ inserted: number }> {
  const template = PERSONA_TEMPLATES[persona];
  if (!template) return { inserted: 0 };
  const events = materialize(template);
  const result = await ingestEvents(actor, events);
  return result;
}

export function listPersonaKeys(): PersonaKey[] {
  return Object.keys(PERSONA_TEMPLATES) as PersonaKey[];
}
