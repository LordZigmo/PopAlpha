/**
 * Single source of truth for the App Store destination.
 *
 * PopAlpha is live on the App Store, so every "Download on the App Store" CTA
 * across the marketing surface points at the real listing. (Pre-launch this was
 * null and CTAs fell back to the on-page waitlist anchor; the waitlist has since
 * been removed.)
 */
export const APP_STORE_URL: string | null =
  "https://apps.apple.com/us/app/popalpha-tcg-scanner/id6762591781";

/**
 * Legacy on-page anchor the pre-launch waitlist forms shared. Retained only as a
 * harmless fallback for `appStoreHref`; nothing links to it now that the listing
 * is live.
 */
export const WAITLIST_ANCHOR = "#waitlist";

/** True once we have a real App Store listing to send people to. */
export const isAppStoreLive = APP_STORE_URL != null;

/** Resolved href for any App Store CTA. */
export const appStoreHref: string = APP_STORE_URL ?? WAITLIST_ANCHOR;
