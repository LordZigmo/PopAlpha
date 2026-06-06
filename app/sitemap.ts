import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";
import { COMPARISONS } from "@/lib/compare/data";

// Only lists routes that actually exist. The compare routes grow automatically as
// entries are added to COMPARISONS.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl();
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/sets`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/search`, lastModified: now, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/data`, lastModified: now, changeFrequency: "daily", priority: 0.5 },
    { url: `${base}/compare`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    {
      url: `${base}/japanese-pokemon-card-prices`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
  ];

  const compareRoutes: MetadataRoute.Sitemap = COMPARISONS.map((entry) => ({
    url: `${base}/compare/${entry.slug}`,
    lastModified: new Date(`${entry.updated}T00:00:00Z`),
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [...staticRoutes, ...compareRoutes];
}
