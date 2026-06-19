import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    // PopAlpha-hosted images (card-art mirror + user avatars) live in the
    // public Supabase Storage bucket. Allow next/image to load/optimize them.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "nbveknrnvcgeyysqrtkl.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
