import type { SupabaseClient } from "@supabase/supabase-js";

export type ParsedMention = {
  mentionText: string;
  startIndex: number;
  endIndex: number;
};

export type ResolvedMention = ParsedMention & {
  canonicalSlug: string;
};

export type PostMentionRow = {
  post_id: number;
  canonical_slug: string;
  mention_text: string;
  start_index: number;
  end_index: number;
};

type CanonicalRow = {
  slug: string;
  canonical_name: string;
};

const SLASH_MENTION_RE = /\/([^/\n]{1,120}?)\//g;

export function parseSlashMentions(body: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  if (!body) return mentions;

  for (const match of body.matchAll(SLASH_MENTION_RE)) {
    const full = match[0];
    const inner = match[1]?.trim() ?? "";
    const index = match.index ?? -1;
    if (!inner || index < 0) continue;

    mentions.push({
      mentionText: inner,
      startIndex: index,
      endIndex: index + full.length,
    });
  }

  return mentions;
}

export async function resolveSlashMentions(
  supabase: SupabaseClient,
  body: string,
): Promise<ResolvedMention[]> {
  const parsed = parseSlashMentions(body);
  if (parsed.length === 0) return [];

  const uniqueNames = [...new Set(parsed.map((item) => item.mentionText))];
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name")
    .in("canonical_name", uniqueNames);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as CanonicalRow[];
  const byName = new Map(rows.map((row) => [row.canonical_name, row.slug]));

  return parsed.flatMap((item) => {
    const canonicalSlug = byName.get(item.mentionText);
    if (!canonicalSlug) return [];
    return [{
      ...item,
      canonicalSlug,
    }];
  });
}

export async function replacePostMentions(
  supabase: SupabaseClient,
  postId: number,
  mentions: ResolvedMention[],
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("profile_post_card_mentions")
    .delete()
    .eq("post_id", postId);

  if (deleteError) throw new Error(deleteError.message);

  if (mentions.length === 0) return;

  const rows = mentions.map((mention) => ({
    post_id: postId,
    canonical_slug: mention.canonicalSlug,
    mention_text: mention.mentionText,
    start_index: mention.startIndex,
    end_index: mention.endIndex,
  }));

  const { error: insertError } = await supabase
    .from("profile_post_card_mentions")
    .insert(rows);

  if (insertError) throw new Error(insertError.message);
}
