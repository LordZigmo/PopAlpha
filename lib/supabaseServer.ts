import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnvs } from "@/lib/env";

let cachedServerClient: SupabaseClient | null = null;

export function getServerSupabaseClient(): SupabaseClient {
  if (cachedServerClient) return cachedServerClient;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getRequiredEnvs([
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  cachedServerClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return cachedServerClient;
}
