import type { ReactNode } from "react";
import Link from "next/link";

export type PostMention = {
  canonical_slug: string;
  mention_text: string;
  start_index: number;
  end_index: number;
};

export default function PostBody({
  body,
  mentions,
}: {
  body: string;
  mentions: PostMention[];
}) {
  if (!mentions.length) {
    return <p className="mt-3 whitespace-pre-wrap text-[14px] leading-6 text-[#D4D4D4]">{body}</p>;
  }

  const ordered = [...mentions].sort((a, b) => a.start_index - b.start_index);
  const segments: ReactNode[] = [];
  let cursor = 0;

  ordered.forEach((mention, index) => {
    const safeStart = Math.max(cursor, mention.start_index);
    const safeEnd = Math.max(safeStart, mention.end_index);

    if (safeStart > cursor) {
      segments.push(body.slice(cursor, safeStart));
    }

    segments.push(
      <Link
        key={`${mention.canonical_slug}-${index}-${mention.start_index}`}
        href={`/c/${encodeURIComponent(mention.canonical_slug)}`}
        className="rounded-full border border-[#1E1E1E] bg-white/[0.04] px-2 py-0.5 font-semibold text-[#9CCBFF] transition hover:text-white"
      >
        /{mention.mention_text}/
      </Link>,
    );
    cursor = safeEnd;
  });

  if (cursor < body.length) {
    segments.push(body.slice(cursor));
  }

  return <p className="mt-3 whitespace-pre-wrap text-[14px] leading-7 text-[#D4D4D4]">{segments}</p>;
}
