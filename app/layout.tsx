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

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "PopAlpha",
  description: "Alternative Asset Portfolio Analytics",
  manifest: "/manifest.webmanifest",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "PopAlpha",
    description: "Alternative Asset Portfolio Analytics",
    url: siteUrl,
    siteName: "PopAlpha",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PopAlpha",
    description: "Alternative Asset Portfolio Analytics",
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
