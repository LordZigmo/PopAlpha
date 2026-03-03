import type { Metadata } from "next";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "./theme-provider";
import AppChrome from "@/components/app-chrome";
import { getSiteUrl } from "@/lib/site-url";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "PopAlpha",
  description: "Alternative Asset Portfolio Analytics",
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

const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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

  // ClerkProvider requires a publishable key — skip during builds without keys
  if (!clerkKey) return inner;

  return <ClerkProvider>{inner}</ClerkProvider>;
}
