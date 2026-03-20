import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

const logoSvg = readFileSync(
  join(process.cwd(), "public/brand/popalpha-icon.svg"),
  "utf8",
);

const logoDataUrl = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString("base64")}`;

function LogoFrame({ size }: { size: number }) {
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
        background: "rgba(0,0,0,0.44)",
        boxShadow: "0 28px 64px rgba(0,0,0,0.35)",
      }}
    >
      <img
        alt="PopAlpha logo"
        src={logoDataUrl}
        width={Math.round(size * 0.8)}
        height={Math.round(size * 0.8)}
      />
    </div>
  );
}

export function createBrandIconResponse(size: number) {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(160deg, #02050b 0%, #071226 52%, #02050b 100%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 50% 18%, rgba(0,180,216,0.18), rgba(0,0,0,0) 58%)",
          }}
        />
        <LogoFrame size={Math.round(size * 0.74)} />
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
