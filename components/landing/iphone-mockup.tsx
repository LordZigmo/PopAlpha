"use client";

import { motion, useReducedMotion } from "framer-motion";

type IphoneScreen = "scanner" | "for-you";

type IphoneMockupProps = {
  size?: "hero" | "marquee";
  screen?: IphoneScreen;
  className?: string;
};

const DIMENSIONS = {
  hero: { width: 280, height: 580, screenInset: 14, notchWidth: 110, notchHeight: 26 },
  marquee: { width: 340, height: 700, screenInset: 16, notchWidth: 130, notchHeight: 30 },
} as const;

export default function IphoneMockup({ size = "hero", screen = "scanner", className = "" }: IphoneMockupProps) {
  const dims = DIMENSIONS[size];
  const reduce = useReducedMotion();
  const animate = !reduce;

  return (
    <div
      className={`relative mx-auto ${className}`}
      style={{ width: dims.width, height: dims.height }}
      aria-hidden="true"
    >
      <div
        className="absolute -inset-6 rounded-[3.6rem] bg-[radial-gradient(circle_at_top,rgba(0,180,216,0.18),transparent_65%)] blur-2xl"
        aria-hidden="true"
      />

      <div className="relative h-full w-full rounded-[3rem] border border-white/[0.08] bg-[linear-gradient(180deg,#1A1D24_0%,#0B0D12_45%,#08090D_100%)] p-[3px] shadow-[0_28px_72px_rgba(0,0,0,0.78)]">
        <div className="relative h-full w-full overflow-hidden rounded-[2.85rem] bg-[#08080C]">
          <div
            className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-black"
            style={{ width: dims.notchWidth, height: dims.notchHeight }}
          >
            <span className="absolute right-3 top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full bg-[#1F2937]" aria-hidden="true" />
          </div>

          <div
            className="flex h-full flex-col"
            style={{
              paddingTop: dims.notchHeight + 16,
              paddingLeft: dims.screenInset,
              paddingRight: dims.screenInset,
              paddingBottom: dims.screenInset,
            }}
          >
            <div className="flex items-center justify-between text-[11px] font-semibold tracking-tight text-white/85">
              <span>9:41</span>
              <div className="flex items-center gap-1.5">
                <SignalGlyph />
                <WifiGlyph />
                <BatteryGlyph />
              </div>
            </div>

            {screen === "scanner" ? (
              <ScannerScreen animate={animate} />
            ) : (
              <ForYouScreen animate={animate} />
            )}

            <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/[0.05] bg-black/35 px-2 py-2 backdrop-blur-sm">
              <TabIcon icon="market" label="Market" active={screen === "for-you"} />
              <TabIcon icon="scan" label="Scan" active={screen === "scanner"} />
              <TabIcon icon="feed" label="Feed" />
              <TabIcon icon="portfolio" label="Portfolio" />
              <TabIcon icon="profile" label="Profile" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Screen: Scanner ───────────────────────────────────────────────────────── */

function ScannerScreen({ animate }: { animate: boolean }) {
  return (
    <>
      <div className="mt-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">Scan</p>
          <p className="mt-0.5 text-[15px] font-semibold tracking-tight text-white">Identify a card</p>
        </div>
        <button
          type="button"
          tabIndex={-1}
          className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold text-[#9FA4AE]"
        >
          EN
        </button>
      </div>

      <div className="relative mt-4 flex-1 overflow-hidden rounded-[1.6rem] border border-white/[0.06] bg-[radial-gradient(circle_at_30%_20%,rgba(0,180,216,0.18),transparent_55%),radial-gradient(circle_at_70%_85%,rgba(124,58,237,0.16),transparent_60%),linear-gradient(180deg,#0B0F18_0%,#06090F_100%)]">
        <div className="absolute inset-0 opacity-[0.06] [background:repeating-linear-gradient(0deg,#fff_0,#fff_1px,transparent_1px,transparent_3px)]" aria-hidden="true" />

        <ScannerBracket position="tl" animate={animate} />
        <ScannerBracket position="tr" animate={animate} />
        <ScannerBracket position="bl" animate={animate} />
        <ScannerBracket position="br" animate={animate} />

        {animate ? (
          <motion.div
            className="absolute inset-x-6 h-[2px] rounded-full bg-[linear-gradient(90deg,transparent,rgba(0,180,216,0.9),transparent)]"
            initial={{ top: "12%", opacity: 0 }}
            animate={{ top: ["12%", "88%", "12%"], opacity: [0, 1, 0] }}
            transition={{ duration: 3.4, ease: "easeInOut", repeat: Infinity }}
          />
        ) : null}

        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[58%] w-[64%] -translate-x-1/2 -translate-y-1/2 rounded-[1.1rem] border border-white/[0.08] bg-white/[0.02] backdrop-blur-[0.5px]" />

        <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/[0.08] bg-black/55 px-3.5 py-3 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold tracking-tight text-white">Charizard ex</p>
              <p className="mt-0.5 truncate text-[10px] text-[#9FA4AE]">199/197 · Obsidian Flames</p>
            </div>
            <div className="text-right">
              <p className="text-[14px] font-semibold tracking-tight text-white">$284</p>
              <p className="text-[10px] font-medium text-[#34D399]">+4.2% 24h</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Screen: For You ───────────────────────────────────────────────────────── */

const FOR_YOU_CARDS = [
  { name: "Umbreon ex", set: "Prismatic Evolutions", price: "$612", change: "+1.8%", badge: "BUY ZONE", trend: "down" as const },
  { name: "Pikachu VMAX", set: "Vivid Voltage", price: "$184", change: "+5.4%", badge: "MATCHES YOU", trend: "up" as const },
  { name: "Sylveon ex", set: "Surging Sparks", price: "$92", change: "-2.1%", badge: "WATCHING", trend: "down" as const },
];

function ForYouScreen({ animate }: { animate: boolean }) {
  return (
    <>
      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">For you</p>
        <p className="mt-0.5 text-[15px] font-semibold tracking-tight text-white">Today&rsquo;s read</p>
      </div>

      <div className="relative mt-3 overflow-hidden rounded-[1.2rem] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(0,180,216,0.12),rgba(124,58,237,0.08))] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-1.5 w-1.5 rounded-full bg-[#00DC5A]">
            {animate ? (
              <motion.span
                className="h-1.5 w-1.5 rounded-full bg-[#00DC5A]"
                animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
              />
            ) : null}
          </span>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7DD3FC]">AI brief</p>
        </div>
        <p className="mt-1.5 text-[11px] leading-[1.45] text-white/90">
          Your watchlist is up <span className="font-semibold text-[#34D399]">+4.2%</span>. 3 cards
          you watch hit a buy zone overnight.
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9FA4AE]">For your collection</p>
        <p className="text-[10px] text-[#6B7280]">Now</p>
      </div>

      <div className="mt-2 flex-1 space-y-2 overflow-hidden">
        {FOR_YOU_CARDS.map((card, index) => (
          <ForYouRow key={card.name} card={card} animate={animate} index={index} />
        ))}
      </div>
    </>
  );
}

function ForYouRow({
  card,
  animate,
  index,
}: {
  card: (typeof FOR_YOU_CARDS)[number];
  animate: boolean;
  index: number;
}) {
  const badgeStyles =
    card.badge === "BUY ZONE"
      ? "border-[#34D399]/30 bg-[#0B231C] text-[#A7F3D0]"
      : card.badge === "MATCHES YOU"
        ? "border-[#7DD3FC]/30 bg-[#0B1E2B] text-[#7DD3FC]"
        : "border-white/10 bg-white/[0.04] text-[#9FA4AE]";

  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 6 } : false}
      animate={animate ? { opacity: 1, y: 0 } : undefined}
      transition={animate ? { duration: 0.35, delay: 0.15 + index * 0.12, ease: "easeOut" } : undefined}
      className="flex items-center justify-between gap-2 rounded-[1rem] border border-white/[0.06] bg-black/40 px-2.5 py-2 backdrop-blur-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11.5px] font-semibold tracking-tight text-white">{card.name}</p>
        <p className="mt-0.5 truncate text-[9.5px] text-[#9FA4AE]">{card.set}</p>
        <span
          className={`mt-1 inline-block rounded-full border px-1.5 py-[1px] text-[8px] font-semibold tracking-[0.1em] ${badgeStyles}`}
        >
          {card.badge}
        </span>
      </div>
      <Sparkline trend={card.trend} />
      <div className="text-right">
        <p className="text-[11px] font-semibold tracking-tight text-white">{card.price}</p>
        <p
          className={`text-[9.5px] font-medium ${card.change.startsWith("-") ? "text-[#FB7185]" : "text-[#34D399]"}`}
        >
          {card.change}
        </p>
      </div>
    </motion.div>
  );
}

function Sparkline({ trend }: { trend: "up" | "down" }) {
  const path =
    trend === "up"
      ? "M0 14 L8 12 L16 13 L24 8 L32 9 L40 4 L48 5"
      : "M0 4 L8 6 L16 5 L24 9 L32 8 L40 12 L48 11";
  const stroke = trend === "up" ? "#34D399" : "#FB7185";
  return (
    <svg width={48} height={16} viewBox="0 0 48 16" aria-hidden="true">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Shared ────────────────────────────────────────────────────────────────── */

function ScannerBracket({ position, animate }: { position: "tl" | "tr" | "bl" | "br"; animate: boolean }) {
  const corner =
    position === "tl"
      ? "left-3 top-3 border-l-2 border-t-2 rounded-tl-[14px]"
      : position === "tr"
        ? "right-3 top-3 border-r-2 border-t-2 rounded-tr-[14px]"
        : position === "bl"
          ? "bottom-3 left-3 border-b-2 border-l-2 rounded-bl-[14px]"
          : "bottom-3 right-3 border-b-2 border-r-2 rounded-br-[14px]";

  return (
    <motion.span
      aria-hidden="true"
      className={`pointer-events-none absolute h-7 w-7 border-[#00B4D8] ${corner}`}
      initial={{ opacity: 0.55, scale: 1 }}
      animate={animate ? { opacity: [0.55, 1, 0.55], scale: [1, 1.06, 1] } : { opacity: 0.85, scale: 1 }}
      transition={animate ? { duration: 1.6, ease: "easeInOut", repeat: Infinity } : { duration: 0 }}
    />
  );
}

type TabIconProps = { icon: "market" | "scan" | "feed" | "portfolio" | "profile"; label: string; active?: boolean };

function TabIcon({ icon, label, active = false }: TabIconProps) {
  const color = active ? "#00B4D8" : "#6B7280";
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon === "market" ? (
          <>
            <path d="M3 17l5-6 4 4 8-9" />
            <path d="M14 6h6v6" />
          </>
        ) : null}
        {icon === "scan" ? (
          <>
            <rect x="3" y="6" width="18" height="13" rx="2.5" />
            <circle cx="12" cy="12.5" r="3.6" />
            <path d="M9 6l1.4-2h3.2L15 6" />
          </>
        ) : null}
        {icon === "feed" ? (
          <>
            <circle cx="12" cy="8" r="3" />
            <path d="M5 20a7 7 0 0114 0" />
          </>
        ) : null}
        {icon === "portfolio" ? (
          <>
            <rect x="3" y="6" width="18" height="14" rx="2" />
            <path d="M3 10h18M9 6V4h6v2" />
          </>
        ) : null}
        {icon === "profile" ? (
          <>
            <circle cx="12" cy="9" r="3.5" />
            <path d="M5 20c1.5-3.5 4.5-5 7-5s5.5 1.5 7 5" />
          </>
        ) : null}
      </svg>
      <span className="text-[8.5px] font-semibold tracking-tight" style={{ color }}>
        {label}
      </span>
    </div>
  );
}

function SignalGlyph() {
  return (
    <svg width={14} height={9} viewBox="0 0 14 9" fill="currentColor" aria-hidden="true">
      <rect x="0" y="6" width="2" height="3" rx="0.5" />
      <rect x="4" y="4" width="2" height="5" rx="0.5" />
      <rect x="8" y="2" width="2" height="7" rx="0.5" />
      <rect x="12" y="0" width="2" height="9" rx="0.5" />
    </svg>
  );
}

function WifiGlyph() {
  return (
    <svg width={13} height={9} viewBox="0 0 13 9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <path d="M1 3.4c1.7-1.5 3.7-2.4 5.5-2.4S10.3 1.9 12 3.4" />
      <path d="M3 5.4c1-1 2.2-1.6 3.5-1.6S8.5 4.4 9.5 5.4" />
      <circle cx="6.5" cy="7.6" r="0.7" fill="currentColor" />
    </svg>
  );
}

function BatteryGlyph() {
  return (
    <svg width={22} height={10} viewBox="0 0 22 10" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="18" height="9" rx="2" stroke="currentColor" />
      <rect x="2" y="2" width="13" height="6" rx="1" fill="currentColor" />
      <rect x="19.5" y="3.5" width="1.6" height="3" rx="0.6" fill="currentColor" />
    </svg>
  );
}
