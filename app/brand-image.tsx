import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// The standard PopAlpha app icon (the mascot) — copied from the iOS AppIcon to
// public/brand/popalpha-app-icon.png. Rendered full-bleed for the web favicon /
// apple-touch icon so the browser tab + home-screen icon match the iOS app.
// Also the only mascot art OG surfaces may use — popalpha-icon.svg is the
// retired old logo (owner, 2026-06-12).
const appIconPng = readFileSync(
  join(process.cwd(), "public/brand/popalpha-app-icon.png"),
);
const appIconDataUrl = `data:image/png;base64,${appIconPng.toString("base64")}`;

function LogoFrame({ size }: { size: number }) {
  // The app icon carries its own dark background, so it renders
  // full-bleed inside the frame — the border + shadow stay as the
  // social-card treatment.
  return (
    <div
      style={{
        display: "flex",
        height: size,
        width: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: Math.round(size * 0.24),
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 28px 64px rgba(0,0,0,0.35)",
      }}
    >
      <img
        alt="PopAlpha logo"
        src={appIconDataUrl}
        width={size}
        height={size}
        style={{ borderRadius: Math.round(size * 0.24) }}
      />
    </div>
  );
}

// Web favicon / apple-touch icon = the standard app icon (the mascot), rendered
// full-bleed. The mascot already carries its own dark background, so it needs no
// frame/gradient chrome — that decorative LogoFrame treatment stays on the
// social share cards (createSocialImageResponse) only.
export function createAppIconResponse(size: number) {
  return new ImageResponse(
    (
      <div style={{ display: "flex", height: "100%", width: "100%" }}>
        <img alt="PopAlpha" src={appIconDataUrl} width={size} height={size} />
      </div>
    ),
    { width: size, height: size },
  );
}

export function createSocialImageResponse({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          background: "linear-gradient(135deg, #02050b 0%, #081223 42%, #02050b 100%)",
          color: "#F0F0F0",
          padding: "56px 64px",
          position: "relative",
          overflow: "hidden",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 22% 18%, rgba(0,180,216,0.22), rgba(0,0,0,0) 36%), radial-gradient(circle at 80% 85%, rgba(0,180,216,0.12), rgba(0,0,0,0) 30%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 32,
            borderRadius: 36,
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        />
        <div
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              maxWidth: 700,
              flexDirection: "column",
              justifyContent: "center",
              gap: 18,
            }}
          >
            <div
              style={{
                display: "flex",
                alignSelf: "flex-start",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                padding: "10px 16px",
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "#9EDCF2",
              }}
            >
              {eyebrow}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 76,
                  lineHeight: 0.95,
                  fontWeight: 800,
                  letterSpacing: "-0.05em",
                }}
              >
                {title}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 32,
                  lineHeight: 1.3,
                  color: "#AFB8C7",
                }}
              >
                {subtitle}
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              minWidth: 320,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <LogoFrame size={280} />
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
