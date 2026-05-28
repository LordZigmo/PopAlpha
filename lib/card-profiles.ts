import "server-only";

import { dbAdmin } from "@/lib/db/admin";

export type CardProfileSummary = {
  summary_short: string;
  summary_long: string | null;
  updated_at: string | null;
};

export type CardProfileDetail = CardProfileSummary & {
  canonical_slug: string;
  signal_label: string | null;
  verdict: string | null;
  chip: string | null;
  created_at: string;
};

export async function loadCardProfileSummary(slug: string): Promise<CardProfileSummary | null> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("card_profiles")
    .select("summary_short, summary_long, updated_at")
    .eq("canonical_slug", slug)
    .maybeSingle<CardProfileSummary>();

  if (error) {
    throw new Error(`Failed reading card profile summary: ${error.message}`);
  }

  return data ?? null;
}

export async function loadCardProfileDetail(slug: string): Promise<CardProfileDetail | null> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("card_profiles")
    .select("canonical_slug, signal_label, verdict, chip, summary_short, summary_long, updated_at, created_at")
    .eq("canonical_slug", slug)
    .maybeSingle<CardProfileDetail>();

  if (error) {
    throw new Error(`Failed reading card profile detail: ${error.message}`);
  }

  return data ?? null;
}
