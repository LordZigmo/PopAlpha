import { NextResponse } from "next/server";

// Apple App Site Association (AASA)
//
// Served from https://popalpha.ai/.well-known/apple-app-site-association
// when the iOS app is installed. Apple's CDN fetches this file and uses
// it to associate `applinks:popalpha.ai` (declared in the app's
// entitlements) with the URL paths listed below.
//
// Why this is a Next.js route handler instead of a static file in
// public/.well-known:
//   - The file has NO extension, and Vercel does not reliably serve
//     extension-less files from `public/` with the correct
//     `Content-Type: application/json` header that Apple requires.
//     Apple silently rejects AASA files served as `text/plain` or
//     `application/octet-stream`.
//   - Doing it as a route handler makes the Content-Type explicit and
//     keeps the team-prefixed bundle ID as code that's reviewable
//     alongside the iOS entitlement that references it.
//
// Verification after deploy:
//   $ curl -i https://popalpha.ai/.well-known/apple-app-site-association
//   Headers should include `Content-Type: application/json`. Body
//   should be valid JSON. Apple's tool:
//   https://app-site-association.cdn-apple.com/a/v1/popalpha.ai
//
// Adding new paths:
//   1. Edit the `components` array below.
//   2. Update the iOS deep-link handler (DeepLinkRouter.swift) to
//      route the new path to the right view.
//   3. Reinstall the app on test devices — Apple caches the AASA per
//      install. Toggling the Associated Domains entitlement off/on in
//      Xcode also forces a refresh.

export const dynamic = "force-dynamic";

// Team-prefixed bundle identifier. Format: <TEAMID>.<BUNDLEID>.
// Mirrors ios/PopAlphaApp.xcodeproj/project.pbxproj
// (DEVELOPMENT_TEAM + PRODUCT_BUNDLE_IDENTIFIER).
const APP_ID = "SR5AZXDJC3.ai.popalpha.ios";

// Path patterns the iOS app handles. Anything not listed falls through
// to Safari, which is the right default for paths the app can't render
// (settings pages, admin routes, etc.).
const COMPONENTS = [
  { "/": "/c/*", comment: "Card detail page" },
  { "/": "/sets/*", comment: "Set browser pages" },
];

const AASA = {
  applinks: {
    details: [
      {
        appIDs: [APP_ID],
        components: COMPONENTS,
      },
    ],
  },
};

export function GET() {
  return NextResponse.json(AASA, {
    headers: {
      // Apple requires application/json; some CDNs default to
      // text/plain for extensionless files.
      "Content-Type": "application/json",
      // Apple's CDN caches AASA files; we don't need additional
      // edge caching from Vercel.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
