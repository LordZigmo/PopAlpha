import "server-only";

import { auth } from "@clerk/nextjs/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbUser } from "@/lib/db";

export async function getCurrentClerkSessionToken(): Promise<string> {
  const { userId, getToken } = await auth();
  if (!userId) {
    throw new Error("createServerSupabaseUserClient() requires an authenticated Clerk user.");
  }

  const token = await getToken();
  if (!token) {
    throw new Error("Clerk did not return a session token for the authenticated user.");
  }

  return token;
}

export async function createServerSupabaseUserClient(): Promise<SupabaseClient> {
  return dbUser(await getCurrentClerkSessionToken());
}
