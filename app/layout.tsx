import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./theme-provider";
import ThemeToggle from "@/components/theme-toggle";
import { getSiteUrl } from "@/lib/site-url";

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
          <div className="fixed right-4 top-4 z-50">
            <ThemeToggle />
          </div>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
