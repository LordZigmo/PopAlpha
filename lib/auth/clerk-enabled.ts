/**
 * Clerk production-safety check.
 *
 * During `next build` (NODE_ENV=production but no runtime server),
 * the key may be empty — that's expected and allowed so static pages
 * can prerender without Clerk.
 *
 * At runtime in production (VERCEL=1 or explicit CLERK_RUNTIME_REQUIRED=1),
 * a missing key is a fatal misconfiguration.
 */

const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

/** True when Clerk is configured and ready to use. */
export const clerkEnabled = key.length > 0;

/**
 * Call from server entry-points that must have Clerk at runtime.
 * Throws a clear error in production if keys are missing;
 * returns silently in dev / build when keys aren't set yet.
 */
export function assertClerkConfigured(): void {
  if (clerkEnabled) return;

  const isRuntimeProd =
    process.env.VERCEL === "1" || process.env.CLERK_RUNTIME_REQUIRED === "1";

  if (isRuntimeProd) {
    throw new Error(
      "[PopAlpha] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. " +
        "Clerk authentication is required in production. " +
        "Add the key to your Vercel environment variables.",
    );
  }
}
