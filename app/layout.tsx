import type { Metadata } from "next";
import "./globals.css";
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <AppChrome>{children}</AppChrome>
        </ThemeProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
