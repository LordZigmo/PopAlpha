import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Anon-key client (singleton) ──────────────────────────────────────────────

let _public: SupabaseClient | null = null;

/**
 * Anon-key Supabase client. Respects RLS.
 * Use for: public reads, user-route queries, page data, lib helpers.
 *
 * With RLS disabled this has identical access to the service-role client.
 * When RLS is enabled, public tables will need anon-read policies.
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

/** @deprecated Use dbPublic() for reads, dbUser() for user routes, or the admin client from "@/lib/db/admin" for privileged ops. */
export function getServerSupabaseClient(): SupabaseClient {
  return dbPublic();
}
