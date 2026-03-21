"use server";

import { redirect } from "next/navigation.js";
import {
  clearInternalAdminSession,
  issueInternalAdminSession,
  resolveCurrentInternalAdminAccess,
} from "@/lib/auth/internal-admin-session";
import {
  sanitizeInternalAdminReturnTo,
} from "@/lib/auth/internal-admin-session-core";

function buildSignInHref(input: {
  returnTo?: string | null;
  error?: "auth_required" | "misconfigured" | "not_authorized";
  notice?: "signed_out";
}): string {
  const search = new URLSearchParams();
  const returnTo = sanitizeInternalAdminReturnTo(input.returnTo ?? undefined);
  if (returnTo) search.set("returnTo", returnTo);
  if (input.error) search.set("error", input.error);
  if (input.notice) search.set("notice", input.notice);
  const query = search.toString();
  return query ? `/internal/admin/sign-in?${query}` : "/internal/admin/sign-in";
}

export async function signInInternalAdminAction(formData: FormData): Promise<never> {
  const returnTo = sanitizeInternalAdminReturnTo(String(formData.get("returnTo") ?? ""));
  const access = await resolveCurrentInternalAdminAccess();

  if (access.kind === "unauthenticated") {
    redirect(buildSignInHref({ returnTo, error: "auth_required" }));
  }

  if (access.kind === "misconfigured") {
    redirect(buildSignInHref({ returnTo, error: "misconfigured" }));
  }

  if (access.kind === "forbidden") {
    redirect(buildSignInHref({ returnTo, error: "not_authorized" }));
  }

  await issueInternalAdminSession(access.operator);
  redirect(returnTo);
}

export async function signOutInternalAdminAction(): Promise<never> {
  await clearInternalAdminSession();
  redirect(buildSignInHref({ notice: "signed_out" }));
}
