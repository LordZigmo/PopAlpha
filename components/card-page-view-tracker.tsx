"use client";

import { useEffect } from "react";

import { trackEvent } from "@/lib/personalization/client/track";

type Props = {
  canonicalSlug: string;
  variantRef: string | null;
};

/**
 * Mounts once per card page and emits a single `card_view` event.
 * Variant changes separately emit `variant_switch` via the raw card market
 * surface click handler.
 */
export default function CardPageViewTracker({ canonicalSlug, variantRef }: Props) {
  useEffect(() => {
    trackEvent({
      type: "card_view",
      canonical_slug: canonicalSlug,
      variant_ref: variantRef,
    });
    // Intentionally only run once on mount, even if variant changes — those
    // are emitted as variant_switch events elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
