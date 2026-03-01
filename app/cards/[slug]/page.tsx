import { redirect } from "next/navigation";

export default async function CardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const nextSearchParams = await searchParams;
  const qs = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(nextSearchParams)) {
    if (rawValue == null) continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        qs.append(key, value);
      }
      continue;
    }
    qs.set(key, rawValue);
  }

  const suffix = qs.toString();
  redirect(suffix ? `/c/${encodeURIComponent(slug)}?${suffix}` : `/c/${encodeURIComponent(slug)}`);
}
