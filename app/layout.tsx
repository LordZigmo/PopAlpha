import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "./theme-provider";
import AppChrome from "@/components/app-chrome";
import { getSiteUrl } from "@/lib/site-url";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { clerkEnabled, assertClerkConfigured } from "@/lib/auth/clerk-enabled";

const siteUrl = getSiteUrl();
const description = "Premium collectibles intelligence for Pokemon card collectors.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "PopAlpha",
  title: "PopAlpha",
  description,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon", sizes: "512x512", type: "image/png" },
      { url: "/brand/popalpha-icon.svg", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
    shortcut: [
      { url: "/icon", sizes: "512x512", type: "image/png" },
    ],
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "PopAlpha",
    description,
    url: siteUrl,
    siteName: "PopAlpha",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "PopAlpha",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "PopAlpha",
    description,
    images: ["/twitter-image"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fail loudly in production if Clerk keys are missing
  assertClerkConfigured();

  const inner = (
    <html lang="en" suppressHydrationWarning data-style="terminal">
      <body className="antialiased">
        <ThemeProvider>
          <AppChrome>{children}</AppChrome>
        </ThemeProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );

  // Skip ClerkProvider during builds without keys (prerender safety)
  if (!clerkEnabled) return inner;

  return <ClerkProvider>{inner}</ClerkProvider>;
}
