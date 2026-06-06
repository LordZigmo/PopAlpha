import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

// First robots policy for the site: allow public crawling, keep crawlers out of
// API/admin/debug/internal and auth routes, and advertise the sitemap.
export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/admin/",
        "/internal/",
        "/debug/",
        "/login",
        "/auth/",
        "/sign-in",
        "/sign-up",
        "/onboarding",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
