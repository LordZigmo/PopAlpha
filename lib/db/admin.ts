/**
 * Service-role Supabase client. Bypasses RLS.
 *
 * ONLY import this in server-side code that genuinely needs
 * service-role access: cron jobs, admin routes, debug routes,
 * ingest pipelines, and backfill scripts.
 *
 * The build guard (scripts/check-dbadmin-imports.mjs) will fail
 * if this is imported from public routes, user routes, pages,
 * lib data readers, or components.
 *
 * For reads and user-scoped writes, use dbPublic() or dbUser()
 * from "@/lib/db" instead.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnvs } from "@/lib/env";

let _admin: SupabaseClient | null = null;

export function dbAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getRequiredEnvs([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return _admin;
}
