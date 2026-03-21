import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { warnIfPricingDbEnvLooksMixed } from "@/lib/db/env-guard";

// ── Anon-key client (singleton) ──────────────────────────────────────────────

let _public: SupabaseClient | null = null;

function getPublicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return { url, anonKey };
}

/**
 * Anon-key Supabase client. Respects RLS.
 * Use for: public reads, user-route queries, page data, lib helpers.
 */
export function dbPublic(): SupabaseClient {
  if (_public) return _public;
  warnIfPricingDbEnvLooksMixed("public_client");
  const { url, anonKey } = getPublicConfig();
  _public = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return _public;
}

// ── Per-request user client ──────────────────────────────────────────────────

/**
 * Per-request Supabase client authenticated with a Clerk session token.
 * Supabase consumes the token through the official `accessToken` hook.
 */
export function dbUser(jwt: string): SupabaseClient {
  const { url, anonKey } = getPublicConfig();
  return createClient(url, anonKey, {
    accessToken: async () => jwt,
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

// ── Backward-compatible re-export ────────────────────────────────────────────

/** @deprecated Use dbPublic() for reads, dbUser() for user routes, or the admin client from "@/lib/db/admin" for privileged ops. */
export function getServerSupabaseClient(): SupabaseClient {
  return dbPublic();
}
