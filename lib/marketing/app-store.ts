/**
 * Single source of truth for the App Store destination.
 *
 * The app is pre-launch, so the live App Store URL does not exist yet. Until it
 * does, every "Download on the App Store" CTA falls back to the on-page waitlist
 * (`#waitlist`) — the real conversion action right now. When the listing is live,
 * set `APP_STORE_URL` to the `https://apps.apple.com/...` link and every CTA across
 * the marketing surface updates at once.
 */
export const APP_STORE_URL: string | null = null;

/** Anchor users land on pre-launch (the hero/CTA waitlist forms share this id). */
export const WAITLIST_ANCHOR = "#waitlist";

/** True once we have a real App Store listing to send people to. */
export const isAppStoreLive = APP_STORE_URL != null;

/** Resolved href for any App Store CTA. */
export const appStoreHref: string = APP_STORE_URL ?? WAITLIST_ANCHOR;
