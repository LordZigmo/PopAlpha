import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

type CardRow = {
  id: string;
  slug: string;
  name: string;
  set: string;
  year: number;
  number: string;
  image_url: string | null;
  rarity: string | null;
  supertype: string | null;
};

type VariantRow = {
  id: string;
  variant_key: string;
  finish: string;
  finish_detail: string | null;
  edition: string;
  stamp: string | null;
};

function finishLabel(value: string): string {
  const map: Record<string, string> = {
    NON_HOLO: "Non-Holo",
    HOLO: "Holo",
    REVERSE_HOLO: "Reverse Holo",
    ALT_HOLO: "Alt Holo",
    UNKNOWN: "Unknown",
  };
  return map[value] ?? value;
}

export default async function CardIdentityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = getServerSupabaseClient();

  const { data: card } = await supabase
    .from("cards")
    .select("id, slug, name, set, year, number, image_url, rarity, supertype")
    .eq("slug", slug)
    .maybeSingle<CardRow>();

  if (!card) notFound();

  const { data: variantsData } = await supabase
    .from("card_variants")
    .select("id, variant_key, finish, finish_detail, edition, stamp")
    .eq("card_id", card.id)
    .order("variant_key", { ascending: true });
  const variants = (variantsData ?? []) as VariantRow[];

  return (
    <main className="app-shell">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link href="/search" className="text-muted text-xs underline underline-offset-4">
          Search results
        </Link>

        <section className="mt-3 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-app text-2xl font-semibold">{card.name}</p>
              <p className="text-muted mt-1 text-sm">
                {card.year || "—"} • {card.set} • #{card.number}
              </p>
              <p className="text-muted mt-1 text-xs">
                {card.supertype ?? "—"}{card.rarity ? ` • ${card.rarity}` : ""}
              </p>
            </div>
            <div className="h-[140px] w-[100px] overflow-hidden rounded-[var(--radius-input)] border-app border bg-surface-soft">
              {card.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={card.image_url} alt={card.name} className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full bg-surface-soft" />
              )}
            </div>
          </div>
        </section>

        <section className="mt-4 glass rounded-[var(--radius-panel)] border-app border p-[var(--space-panel)]">
          <p className="text-app text-sm font-semibold uppercase tracking-[0.12em]">Variants</p>
          {variants.length === 0 ? (
            <p className="text-muted mt-2 text-sm">No variants found yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {variants.map((variant) => (
                <li key={variant.id} className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
                  <p className="text-app text-sm font-semibold">
                    {finishLabel(variant.finish)}
                    {variant.edition === "FIRST_EDITION" ? " • 1st Edition" : ""}
                    {variant.stamp ? ` • ${variant.stamp}` : ""}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    Key: {variant.variant_key}
                    {variant.finish_detail ? ` • Detail: ${variant.finish_detail}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

