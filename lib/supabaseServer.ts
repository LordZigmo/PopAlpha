import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredEnv } from "@/lib/env";

let cachedServerClient: SupabaseClient | null = null;

function getServerSupabaseUrl(): string {
  const serverUrl = process.env.SUPABASE_URL?.trim();
  if (serverUrl) return serverUrl;

  const fallbackPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (fallbackPublicUrl) return fallbackPublicUrl;

  throw new Error(
    "Missing required environment variable: SUPABASE_URL. If you only set NEXT_PUBLIC_SUPABASE_URL, copy that same value into SUPABASE_URL for server routes."
  );
}

export function getServerSupabaseClient(): SupabaseClient {
  if (cachedServerClient) return cachedServerClient;

  const supabaseUrl = getServerSupabaseUrl();
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  cachedServerClient = createClient(supabaseUrl, serviceRoleKey);
  return cachedServerClient;
}
