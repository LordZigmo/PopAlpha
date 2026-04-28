/**
 * Vision-language pre-labeling for the eval-seeding flow.
 *
 * Reads a captured Pokemon TCG card image and extracts the
 * structured fields we need to look up its canonical_slug:
 * card name, set name (or set code printed bottom-right), and
 * collector number. We then resolve those fields against
 * canonical_cards in the DB (see lib/data/canonical-card-match)
 * and present the operator with confirmable suggestions.
 *
 * The VLM is intentionally NOT asked to produce slugs directly —
 * it's a generalist that doesn't know our taxonomy. Asking it to
 * read what's printed on the card and letting our DB resolve the
 * slug is much more reliable.
 *
 * Cost: gemini-2.5-flash @ ~$0.0007/image. For a 5K-image labeling
 * sprint that's <$5. Negligible.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { getPopAlphaModel } from "@/lib/ai/models";

export const VLM_PRELABEL_MODEL_TIER = "Ace" as const;
export const VLM_PRELABEL_TIMEOUT_MS = 12_000;
// Stable ID stored alongside any persisted suggestions so we can
// re-process when the prompt or model materially changes.
export const VLM_PRELABEL_VERSION = "vlm-prelabel-v1";

const SYSTEM_PROMPT = [
  "You are an expert Pokemon Trading Card Game cataloger.",
  "You will be shown ONE photo of a Pokemon TCG card. Your job is to read",
  "what is printed on the card and extract structured fields.",
  "",
  "What you should look for, in priority order:",
  "  1. The card NAME (large text near the top of the card).",
  "  2. The COLLECTOR NUMBER, which is a fraction like '23/159' or",
  "     '177/217'. It is usually printed in small text at the bottom of",
  "     the card — often bottom-LEFT for older sets, bottom-RIGHT for",
  "     newer ones. Sometimes appears near the set symbol.",
  "  3. The SET NAME — printed in small text near the bottom, sometimes",
  "     replaced or supplemented by a SET SYMBOL (a small icon).",
  "  4. The SET CODE if visible (e.g. 'JTG' for Journey Together, 'PRE'",
  "     for Prismatic Evolutions, '151' for Pokemon 151).",
  "",
  "Be conservative — if a field is not legible, set it to null. Do NOT",
  "guess. The downstream system will use exact matching to find the",
  "canonical card; a wrong guess is much worse than a null.",
  "",
  "If the image does NOT contain a Pokemon TCG card (e.g. it shows a",
  "different game's card, or just a sleeve, or a non-card object), set",
  "is_pokemon_tcg to false and return nulls for the other fields.",
  "",
  "Pokemon TCG cards have these visual signatures:",
  "  - 'Pokemon' or 'Pokémon' wordmark, often near the top.",
  "  - HP value (e.g. '120 HP', 'HP 60') near the top-right for",
  "    Pokemon cards (not Trainer/Energy).",
  "  - Energy symbols (small colored circles) on attacks.",
  "  - Pokemon character art in the central frame.",
  "",
  "Output ONLY the structured JSON the schema demands.",
].join("\n");

const VlmGuessSchema = z.object({
  is_pokemon_tcg: z
    .boolean()
    .describe("True if the image shows an English- or Japanese-language Pokemon TCG card. False for other TCGs, sleeves, non-card objects."),
  card_name: z
    .string()
    .nullable()
    .describe("The card's printed name as it appears on the card (e.g. 'Combusken', 'Hop's Cramorant', 'Energy Recycler'). Null if unreadable."),
  set_name: z
    .string()
    .nullable()
    .describe("The expansion / set name if printed or strongly inferable from the set symbol (e.g. 'Journey Together', 'Prismatic Evolutions'). Null if unclear."),
  set_code: z
    .string()
    .nullable()
    .describe("Three-or-more letter set code if printed (e.g. 'JTG', 'PRE', '151'). Null if not visible."),
  collector_number_full: z
    .string()
    .nullable()
    .describe("The collector number as printed, including total if shown (e.g. '23/159', '177/217', '044/030'). Null if not legible."),
  collector_number: z
    .string()
    .nullable()
    .describe("The number-within-set portion only, as a string preserving leading zeros (e.g. '23', '044', 'TG04'). Promo codes like 'SWSH062' or 'SV-P 037' should be returned as-is. Null if not legible."),
  card_kind: z
    .enum(["pokemon", "trainer", "energy", "unknown"])
    .describe("Category of the card. Pokemon = has HP and attacks. Trainer = item / supporter / stadium / tool. Energy = energy card. Unknown if cannot determine."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("How sure you are about the (card_name, collector_number) pair. high: all fields read clearly. medium: name OR number unclear but readable. low: heavily occluded / blurry / glare."),
});

export type VlmCardGuess = z.infer<typeof VlmGuessSchema>;

export class VlmPrelabelError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VlmPrelabelError";
  }
}

/**
 * Send the captured card image to Gemini and extract structured
 * fields. Throws VlmPrelabelError on any failure — caller handles
 * gracefully (per the silent-fallback playbook lesson, no blanket
 * try/catch that swallows).
 */
export async function prelabelCardImage(
  imageBytes: Buffer,
  imageMimeType: string,
): Promise<VlmCardGuess> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    VLM_PRELABEL_TIMEOUT_MS,
  );

  try {
    const result = await generateObject({
      model: getPopAlphaModel(VLM_PRELABEL_MODEL_TIER),
      schema: VlmGuessSchema,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read this Pokemon TCG card and extract its structured fields per the schema.",
            },
            {
              type: "image",
              image: imageBytes,
              mediaType: imageMimeType,
            },
          ],
        },
      ],
      abortSignal: abortController.signal,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "card-vlm-prelabel",
      },
    });

    return result.object;
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[card-vlm-prelabel] generateObject failed: ${errName}: ${errMsg}`,
    );
    throw new VlmPrelabelError(`${errName}: ${errMsg}`, err);
  } finally {
    clearTimeout(timeoutId);
  }
}
