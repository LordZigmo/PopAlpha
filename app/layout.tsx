import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "./theme-provider";
import AppChrome from "@/components/app-chrome";
import PostHogProvider from "@/components/posthog-provider";
import { getSiteUrl } from "@/lib/site-url";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { clerkEnabled, assertClerkConfigured } from "@/lib/auth/clerk-enabled";

const siteUrl = getSiteUrl();
const description = "PopAlpha is the iPhone app for Pok\u00e9mon collectors. Snap any card to identify it instantly, follow market intelligence on movers and breakouts, track your portfolio, and get push alerts on live signals. Join the waitlist.";
const title = "PopAlpha \u2014 Pok\u00e9mon Card Intelligence on iPhone";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "PopAlpha",
  title,
  description,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon?v=4", sizes: "512x512", type: "image/png" },
      { url: "/brand/popalpha-icon.svg?v=4", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/apple-icon?v=4", sizes: "180x180", type: "image/png" },
    ],
    shortcut: [
      { url: "/icon?v=4", sizes: "512x512", type: "image/png" },
    ],
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title,
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
    title,
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
        <PostHogProvider>
          <ThemeProvider>
            <AppChrome>{children}</AppChrome>
          </ThemeProvider>
        </PostHogProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );

  // Skip ClerkProvider during builds without keys (prerender safety)
  if (!clerkEnabled) return inner;

  return <ClerkProvider>{inner}</ClerkProvider>;
}
