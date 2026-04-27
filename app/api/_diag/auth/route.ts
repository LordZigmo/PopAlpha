import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic endpoint — returns what the server sees when an
 * iOS Bearer token comes in. Used to figure out why `auth()` is returning
 * null userId for valid Clerk JWTs from the iOS app. Delete this route
 * (and its registry entry in lib/auth/route-registry.ts) once the auth
 * mismatch is resolved.
 *
 * Returns JSON, not HTML, so iOS / curl can read it directly. No secrets
 * are echoed — only key *prefixes* and presence flags.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const result: Record<string, unknown> = {
    received_authorization_header: authHeader.length > 0,
    bearer_length: bearer.length,
    bearer_prefix: bearer.slice(0, 20),
    bearer_jwt_segments: bearer.split(".").length,
    server_publishable_key_prefix:
      (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").slice(0, 12),
    server_secret_key_prefix:
      (process.env.CLERK_SECRET_KEY ?? "").slice(0, 8),
    server_publishable_key_length:
      (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").length,
    server_secret_key_length:
      (process.env.CLERK_SECRET_KEY ?? "").length,
  };

  // What does auth() see?
  try {
    const a = await auth();
    result.auth_user_id = a.userId ?? null;
    result.auth_session_id = a.sessionId ?? null;
    result.auth_token_type = (a as unknown as { tokenType?: string }).tokenType ?? null;
  } catch (err) {
    result.auth_error = err instanceof Error ? err.message : String(err);
  }

  // Independent path: explicit authenticateRequest() so we can see if
  // the JWT validates outside of the middleware-set context.
  try {
    const client = await clerkClient();
    const ar = await client.authenticateRequest(req);
    result.authenticate_request_status = ar.status;
    result.authenticate_request_reason = ar.reason ?? null;
    result.authenticate_request_message = ar.message ?? null;
    if (ar.isAuthenticated) {
      const ao = ar.toAuth();
      result.authenticate_request_user_id = ao?.userId ?? null;
    }
  } catch (err) {
    result.authenticate_request_error = err instanceof Error ? err.message : String(err);
  }

  // Decode the JWT payload (no signature check) so we can inspect its
  // claims without relying on Clerk's validation. Helps spot
  // issuer/audience mismatches.
  if (bearer.split(".").length === 3) {
    try {
      const payload = bearer.split(".")[1];
      const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      const claims = JSON.parse(decoded);
      result.jwt_iss = claims.iss ?? null;
      result.jwt_aud = claims.aud ?? null;
      result.jwt_sub = claims.sub ?? null;
      result.jwt_exp = claims.exp ?? null;
      result.jwt_iat = claims.iat ?? null;
      result.jwt_now = Math.floor(Date.now() / 1000);
      result.jwt_expired = typeof claims.exp === "number" ? claims.exp < Math.floor(Date.now() / 1000) : null;
    } catch (err) {
      result.jwt_decode_error = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json(result);
}
