import Link from "next/link";
import { notFound } from "next/navigation";
import CardDetailInstruments from "@/components/card-detail-instruments";
import type { CardDetailResponse } from "@/lib/cards/detail-types";
import { getSiteUrl } from "@/lib/site-url";

async function loadCardDetail(slug: string): Promise<CardDetailResponse | null> {
  const response = await fetch(`${getSiteUrl()}/api/cards/${encodeURIComponent(slug)}/detail`, {
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed loading card detail: ${response.status}`);
  }

  return (await response.json()) as CardDetailResponse;
}

function subtitle(detail: CardDetailResponse): string {
  return [
    detail.canonical.year ? String(detail.canonical.year) : null,
    detail.canonical.setName,
    detail.canonical.cardNumber ? `#${detail.canonical.cardNumber}` : null,
    detail.canonical.language,
  ]
    .filter(Boolean)
    .join(" • ");
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const detail = await loadCardDetail(slug);

  if (!detail) {
    notFound();
  }

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-3 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-2xl font-semibold">{detail.canonical.name}</p>
          <p className="text-muted mt-1 text-sm">{subtitle(detail)}</p>
          <p className="text-muted mt-3 text-xs">
            UI root identity: <span className="font-semibold">{detail.canonical.slug}</span>
          </p>
        </section>

        <CardDetailInstruments detail={detail} />
      </div>
    </main>
  );
}
