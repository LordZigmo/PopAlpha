"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SignedIn, SignedOut, useUser } from "@clerk/nextjs";
import { Home, PieChart, Plus, Users } from "lucide-react";

const DESKTOP_LEFT_RAIL_WIDTH = "md:w-[min(30vw,22rem)]";

type SummaryResponse = {
  ok: boolean;
  collectionValue?: number;
  accuracyScore?: number | null;
  setCompletion: {
    setName: string;
    ownedCount: number;
    totalCount: number;
    percent: number;
  } | null;
  watchlist: Array<{
    slug: string;
    name: string;
    setName: string | null;
    imageUrl: string | null;
    currentPrice: number | null;
    isHotMover: boolean;
  }>;
};

type SuggestResponse = {
  ok: boolean;
  cards: Array<{
    slug: string;
    canonical_name: string;
    set_name: string | null;
    year: number | null;
  }>;
};

function resolveTier(value: unknown): "Trainer" | "Ace" | "Elite" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "elite") return "Elite";
  if (normalized === "ace") return "Ace";
  return "Trainer";
}

function tierBadgeClass(tier: "Trainer" | "Ace" | "Elite"): string {
  if (tier === "Elite") return "border-[#2A5BFF]/30 bg-[#1D4ED8]/12 text-[#A9C7FF]";
  if (tier === "Ace") return "border-[#94A3B8]/25 bg-white/[0.05] text-[#DDE8FF]";
  return "border-emerald-400/20 bg-[linear-gradient(135deg,#10B981,#047857)] text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.22)]";
}

function NavItem({
  href,
  label,
  active,
  icon: Icon,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: typeof Home;
}) {
  return (
    <Link
      href={href}
      className={[
        "flex items-center gap-3 rounded-[1.1rem] border px-4 py-3 transition",
        active
          ? "border-white/[0.08] bg-white/[0.05] text-white"
          : "border-transparent bg-transparent text-[#B0B0B0] hover:border-white/[0.05] hover:bg-white/[0.03] hover:text-white",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-10 w-10 items-center justify-center rounded-[0.9rem] border",
          active
            ? "border-white/[0.08] bg-white/[0.06] text-white"
            : "border-[#1E1E1E] bg-[#0B0B0B] text-[#6B7280]",
        ].join(" ")}
      >
        <Icon size={18} strokeWidth={2.1} />
      </span>
      <span className="text-[15px] font-semibold">{label}</span>
    </Link>
  );
}

export default function DesktopLeftRail() {
  const pathname = usePathname();
  const { user } = useUser();
  const currentPath = pathname ?? "/";
  const tier = resolveTier(
    user?.publicMetadata.subscriptionTier ?? user?.publicMetadata.tier ?? user?.publicMetadata.plan,
  );

  const [summary, setSummary] = useState<SummaryResponse["setCompletion"]>(null);
  const [collectionValue, setCollectionValue] = useState(0);
  const [accuracyScore, setAccuracyScore] = useState<number | null>(null);
  const [watchlist, setWatchlist] = useState<SummaryResponse["watchlist"]>([]);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestResponse["cards"]>([]);
  const [selectedCard, setSelectedCard] = useState<SuggestResponse["cards"][number] | null>(null);
  const [condition, setCondition] = useState<"RAW" | "GRADED">("RAW");
  const [gradingCompany, setGradingCompany] = useState("PSA");
  const [gradeValue, setGradeValue] = useState("");
  const [qty, setQty] = useState("1");
  const [pricePaid, setPricePaid] = useState("");
  const [acquiredOn, setAcquiredOn] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!user) {
      setSummary(null);
      setWatchlist([]);
      setSummaryLoaded(true);
      return;
    }

    let cancelled = false;

    void fetch("/api/holdings/summary", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as SummaryResponse;
        if (!response.ok || !payload.ok) {
          throw new Error("Could not load holdings summary.");
        }
        if (!cancelled) {
          setCollectionValue(payload.collectionValue ?? 0);
          setAccuracyScore(payload.accuracyScore ?? null);
          setSummary(payload.setCompletion);
          setWatchlist(payload.watchlist ?? []);
          setSummaryLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCollectionValue(0);
          setAccuracyScore(null);
          setSummary(null);
          setWatchlist([]);
          setSummaryLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!addOpen) return;
    setTimeout(() => modalRef.current?.focus(), 0);
  }, [addOpen]);

  useEffect(() => {
    if (!addOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [addOpen]);

  useEffect(() => {
    if (!addOpen) return;
    const query = search.trim();
    if (query.length < 2 || selectedCard?.canonical_name === query) {
      if (!selectedCard?.canonical_name || selectedCard.canonical_name === query) {
        setSuggestions([]);
      }
      return;
    }

    let cancelled = false;
    const timeoutId = setTimeout(() => {
      void fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`, { cache: "no-store" })
        .then(async (response) => {
          const payload = (await response.json()) as SuggestResponse;
          if (!response.ok || !payload.ok) throw new Error("Could not search cards.");
          if (!cancelled) setSuggestions(payload.cards ?? []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [addOpen, search, selectedCard]);

  const progressWidth = useMemo(() => {
    const percent = summary?.percent ?? 0;
    return `${Math.max(0, Math.min(100, percent))}%`;
  }, [summary]);

  function openAddModal() {
    setAddOpen(true);
    setSearch("");
    setSuggestions([]);
    setSelectedCard(null);
    setCondition("RAW");
    setGradingCompany("PSA");
    setGradeValue("");
    setQty("1");
    setPricePaid("");
    setAcquiredOn("");
    setCertNumber("");
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedCard) {
      setError("Pick a card first.");
      return;
    }
    const parsedPrice = Number(pricePaid);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setError("Enter a valid price paid.");
      return;
    }
    const parsedQty = Math.floor(Number(qty));
    if (!Number.isFinite(parsedQty) || parsedQty < 1) {
      setError("Enter a valid quantity.");
      return;
    }
    if (condition === "GRADED" && !gradeValue.trim()) {
      setError("Enter the assigned grade.");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);

    const grade = condition === "RAW"
      ? "RAW"
      : `${gradingCompany.trim()} ${gradeValue.trim()}`.trim();

    try {
      const response = await fetch("/api/holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_slug: selectedCard.slug,
          grade,
          qty: parsedQty,
          price_paid_usd: parsedPrice,
          acquired_on: acquiredOn || null,
          cert_number: certNumber.trim() || null,
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Could not add to portfolio.");
      }

      const summaryResponse = await fetch("/api/holdings/summary", { cache: "no-store" });
      const summaryPayload = (await summaryResponse.json()) as SummaryResponse;
      if (summaryResponse.ok && summaryPayload.ok) {
        setCollectionValue(summaryPayload.collectionValue ?? 0);
        setAccuracyScore(summaryPayload.accuracyScore ?? null);
        setSummary(summaryPayload.setCompletion);
        setWatchlist(summaryPayload.watchlist ?? []);
      }

      setNotice("Added to portfolio.");
      setSaving(false);
      setTimeout(() => {
        setAddOpen(false);
        setNotice(null);
      }, 900);
    } catch (submitError) {
      setSaving(false);
      setError(submitError instanceof Error ? submitError.message : "Could not add to portfolio.");
    }
  }

  return (
    <>
      <aside className={`fixed inset-y-0 left-0 z-30 hidden ${DESKTOP_LEFT_RAIL_WIDTH} md:block`}>
        <div className="sticky top-0 flex h-screen w-full flex-col border-r border-[#1E1E1E] bg-[#0A0A0A]/92 px-5 py-6 backdrop-blur-xl">
          <section className="rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Identity</p>
            <div className="mt-4 flex items-center gap-4">
              <SignedIn>
                {user?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.imageUrl}
                    alt={user.fullName ?? user.username ?? "User avatar"}
                    className="h-14 w-14 rounded-[1.1rem] object-cover ring-1 ring-white/[0.06]"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-[1.1rem] bg-white/[0.04] text-[18px] font-semibold text-white">
                    {(user?.firstName?.[0] ?? user?.username?.[0] ?? "P").toUpperCase()}
                  </div>
                )}
              </SignedIn>
              <SignedOut>
                <div className="flex h-14 w-14 items-center justify-center rounded-[1.1rem] bg-white/[0.04] text-[18px] font-semibold text-white">
                  P
                </div>
              </SignedOut>
              <div className="min-w-0">
                <p className="truncate text-[16px] font-semibold text-white">
                  {user?.fullName ?? user?.username ?? "PopAlpha User"}
                </p>
                <p className="mt-1 font-mono text-[13px] font-semibold text-[#D4D4D8]">
                  ${collectionValue.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
                <span
                  className={[
                    "mt-2 inline-flex rounded-full border px-3 py-1 text-[12px] font-bold uppercase tracking-[0.16em]",
                    tierBadgeClass(tier),
                  ].join(" ")}
                >
                  {tier}
                </span>
                <div className="mt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6B7280]">Alpha Rank</p>
                  <p className="mt-1 text-[12px] font-semibold text-[#A1A1AA]">
                    Accuracy{" "}
                    <span className="font-mono text-white">
                      {accuracyScore != null ? `${accuracyScore}%` : "—"}
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-4">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Navigation</p>
            <div className="mt-3 space-y-1.5">
              <NavItem href="/" label="Home" icon={Home} active={currentPath === "/"} />
              <NavItem
                href="/profile"
                label="Profile"
                icon={Users}
                active={currentPath === "/profile" || currentPath.startsWith("/profile/") || currentPath.startsWith("/u/")}
              />
              <NavItem
                href="/portfolio"
                label="Portfolio"
                icon={PieChart}
                active={currentPath === "/portfolio" || currentPath.startsWith("/portfolio/")}
              />
            </div>
          </section>

          <section className="mt-5 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Motivation</p>
            <div className="mt-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold text-white">Master Set Completion</p>
                <p className="mt-1 text-[13px] text-[#8A8A8A]">
                  {summaryLoaded
                    ? (summary?.setName ?? "Build your first set")
                    : "Loading..."}
                </p>
              </div>
              <p className="text-[15px] font-bold text-[#8DF0B4]">
                {summary?.percent ?? 0}%
              </p>
            </div>
            <div className="mt-3 overflow-hidden rounded-full bg-white/[0.04]">
              <div className="h-1.5 rounded-full bg-[linear-gradient(90deg,#3B82F6,#4F46E5)]" style={{ width: progressWidth }} />
            </div>
            <p className="mt-2 text-[12px] text-[#6B7280]">
              {summary
                ? `${summary.ownedCount} of ${summary.totalCount} tracked cards completed.`
                : "Add cards to start tracking set completion."}
            </p>
          </section>

          <section className="mt-5 flex-1 rounded-[1.8rem] border border-white/[0.06] bg-zinc-900/40 p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Focus</p>
                <p className="mt-3 text-[15px] font-semibold text-white">Personal Watchlist</p>
              </div>
              <button
                type="button"
                onClick={openAddModal}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.05] text-white transition hover:bg-white/[0.08]"
                aria-label="Add to portfolio"
                title="Add to portfolio"
              >
                <Plus size={16} strokeWidth={2.4} />
              </button>
            </div>
            <div className="mt-4 space-y-2.5">
              {watchlist.length > 0 ? watchlist.slice(0, 5).map((item) => (
                <Link
                  key={item.slug}
                  href={`/c/${encodeURIComponent(item.slug)}`}
                  className="flex items-center gap-3 rounded-[1rem] border border-[#1E1E1E] bg-[#0B0B0B] px-3 py-3 text-[#D4D4D4] transition hover:border-white/[0.06] hover:text-white"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 shrink-0 overflow-hidden rounded-[0.2rem] border border-white/[0.06] bg-white/[0.03]">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.imageUrl} alt={item.name} className="h-full w-full object-cover" />
                        ) : null}
                      </div>
                      <p className="truncate text-[14px] font-semibold">{item.name}</p>
                    </div>
                    <p className="truncate text-[12px] text-[#6B7280]">{item.setName ?? "Unknown set"}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {item.isHotMover ? <span className="h-2 w-2 rounded-full bg-[#EF4444] animate-pulse" /> : null}
                    <span className="font-mono text-[12px] font-semibold text-[#E4E4E7]">
                      {item.currentPrice != null
                        ? `$${item.currentPrice.toLocaleString(undefined, {
                            minimumFractionDigits: item.currentPrice >= 10 ? 0 : 2,
                            maximumFractionDigits: item.currentPrice >= 10 ? 0 : 2,
                          })}`
                        : "—"}
                    </span>
                  </div>
                </Link>
              )) : (
                <div className="rounded-[1rem] border border-dashed border-white/[0.06] bg-[#0B0B0B] px-4 py-4 text-[13px] text-[#6B7280]">
                  Add your first card to start a watchlist here.
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>

      {addOpen ? (
        <div
          className="fixed inset-0 z-[90] hidden md:block"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAddOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div
              ref={modalRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              className="w-full max-w-xl rounded-[2rem] border border-white/[0.08] bg-[#0E0E0E] p-6 outline-none shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Portfolio</p>
                  <h3 className="mt-2 text-[24px] font-semibold tracking-[-0.03em] text-white">Add Card</h3>
                  <p className="mt-2 text-[14px] leading-6 text-[#8A8A8A]">
                    Add one card to your portfolio and record what you paid.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-white transition hover:bg-white/[0.06]"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {error ? (
                <p className="mt-4 rounded-2xl border border-[#4A1A1A] bg-[#2A1212] px-4 py-3 text-[13px] text-[#FFB4B4]">{error}</p>
              ) : null}
              {notice ? (
                <p className="mt-4 rounded-2xl border border-[#16311E] bg-[#102116] px-4 py-3 text-[13px] text-[#8DF0B4]">{notice}</p>
              ) : null}

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                <div className="space-y-2">
                  <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Card</label>
                  <div className="relative">
                    <input
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setSelectedCard(null);
                      }}
                      placeholder="Search for a card..."
                      className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                    />
                    {suggestions.length > 0 && !selectedCard ? (
                      <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-10 overflow-hidden rounded-2xl border border-[#1E1E1E] bg-[#0B0B0B] shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
                        {suggestions.map((item) => (
                          <button
                            key={item.slug}
                            type="button"
                            onClick={() => {
                              setSelectedCard(item);
                              setSearch(item.canonical_name);
                              setSuggestions([]);
                            }}
                            className="block w-full border-b border-white/[0.04] px-4 py-3 text-left last:border-b-0 hover:bg-white/[0.03]"
                          >
                            <p className="text-[14px] font-semibold text-white">{item.canonical_name}</p>
                            <p className="mt-1 text-[12px] text-[#6B7280]">
                              {item.set_name ?? "Unknown set"}{item.year ? ` • ${item.year}` : ""}
                            </p>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Condition</label>
                    <select
                      value={condition}
                      onChange={(event) => setCondition(event.target.value as "RAW" | "GRADED")}
                      className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                    >
                      <option value="RAW">Raw</option>
                      <option value="GRADED">Graded</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Quantity</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={qty}
                      onChange={(event) => setQty(event.target.value)}
                      className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Price Paid</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={pricePaid}
                      onChange={(event) => setPricePaid(event.target.value)}
                      placeholder="0.00"
                      className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Acquired On</label>
                    <input
                      type="date"
                      value={acquiredOn}
                      onChange={(event) => setAcquiredOn(event.target.value)}
                      className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                    />
                  </div>
                </div>

                {condition === "GRADED" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Grader</label>
                      <select
                        value={gradingCompany}
                        onChange={(event) => setGradingCompany(event.target.value)}
                        className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                      >
                        <option value="PSA">PSA</option>
                        <option value="BGS">BGS</option>
                        <option value="CGC">CGC</option>
                        <option value="TAG">TAG</option>
                        <option value="SGC">SGC</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Grade</label>
                      <input
                        value={gradeValue}
                        onChange={(event) => setGradeValue(event.target.value)}
                        placeholder="10, 9.5, Gem Mint..."
                        className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                      />
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <label className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Cert Number (Optional)</label>
                  <input
                    value={certNumber}
                    onChange={(event) => setCertNumber(event.target.value)}
                    placeholder="Certification number"
                    className="w-full rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-3 text-[14px] text-white outline-none"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setAddOpen(false)}
                    className="rounded-2xl border border-[#1E1E1E] px-4 py-3 text-[14px] font-semibold text-[#A3A3A3] transition hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-2xl border border-white/[0.08] bg-white text-[#0A0A0A] px-5 py-3 text-[14px] font-semibold transition hover:bg-white/90 disabled:opacity-60"
                  >
                    {saving ? "Saving..." : "Add to Portfolio"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
