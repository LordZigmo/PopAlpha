import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnvs } from "@/lib/env";

// ── Service-role client (singleton) ──────────────────────────────────────────

let _admin: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Bypasses RLS.
 * Use for: cron jobs, admin routes, ingest pipelines, maintenance.
 */
export function dbAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getRequiredEnvs([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return _admin;
}

// ── Anon-key client (singleton) ──────────────────────────────────────────────

let _public: SupabaseClient | null = null;

/**
 * Anon-key Supabase client. Respects RLS.
 * Use for: public reads (once RLS policies exist for public tables).
 * Interim: public routes still use dbAdmin() since no public-table RLS exists yet.
 */
export function dbPublic(): SupabaseClient {
  if (_public) return _public;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  _public = createClient(url, anonKey);
  return _public;
}

// ── Per-request user client ──────────────────────────────────────────────────

/**
 * Per-request Supabase client authenticated with a user JWT. Respects RLS.
 *
 * CLERK SWAP POINT: Update to get Clerk token:
 *   const { getToken } = await auth();
 *   const token = await getToken({ template: "supabase" });
 */
export function dbUser(jwt: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

// ── Backward-compatible re-export ────────────────────────────────────────────

/** @deprecated Use dbAdmin() instead. */
export function getServerSupabaseClient(): SupabaseClient {
  return dbAdmin();
}
