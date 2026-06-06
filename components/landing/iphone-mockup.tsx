import Image from "next/image";

type IphoneScreen = "scanner" | "for-you" | "brief" | "jp-pricing" | "portfolio";

type IphoneMockupProps = {
  size?: "hero" | "marquee";
  /** Identifies which app screenshot belongs in this frame (kept so callers stay stable). */
  screen?: IphoneScreen;
  /** App screenshot to show inside the frame. Omit for an empty placeholder. */
  src?: string;
  alt?: string;
  className?: string;
};

const DIMENSIONS = {
  hero: { width: 280, height: 580, notchWidth: 110, notchHeight: 26 },
  marquee: { width: 340, height: 700, notchWidth: 130, notchHeight: 30 },
} as const;

// Device frame only. The screen is intentionally empty (or shows `src` when provided)
// so real app screenshots can be dropped in per `screen` — pass e.g.
// `<IphoneMockup screen="scanner" src="/screenshots/scanner.png" alt="Scanner" />`.
export default function IphoneMockup({
  size = "hero",
  screen,
  src,
  alt = "",
  className = "",
}: IphoneMockupProps) {
  const dims = DIMENSIONS[size];

  return (
    <div
      className={`relative mx-auto ${className}`}
      style={{ width: dims.width, height: dims.height }}
      aria-hidden={src ? undefined : true}
    >
      <div
        className="absolute -inset-6 rounded-[3.6rem] bg-[radial-gradient(circle_at_top,rgba(0,180,216,0.18),transparent_65%)] blur-2xl"
        aria-hidden="true"
      />

      <div className="relative h-full w-full rounded-[3rem] border border-white/[0.08] bg-[linear-gradient(180deg,#1A1D24_0%,#0B0D12_45%,#08090D_100%)] p-[3px] shadow-[0_28px_72px_rgba(0,0,0,0.78)]">
        <div className="relative h-full w-full overflow-hidden rounded-[2.85rem] bg-[#08080C]">
          {src ? (
            <Image
              src={src}
              alt={alt}
              fill
              sizes={`${dims.width}px`}
              className="object-cover"
              data-screen={screen}
            />
          ) : (
            <div
              className="h-full w-full bg-[radial-gradient(circle_at_50%_28%,rgba(0,180,216,0.07),transparent_60%),linear-gradient(180deg,#0B0D12_0%,#08090D_100%)]"
              data-screen={screen}
            />
          )}

          <div
            className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-black"
            style={{ width: dims.notchWidth, height: dims.notchHeight }}
          >
            <span
              className="absolute right-3 top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-[#1F2937]"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
