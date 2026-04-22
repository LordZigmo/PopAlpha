"use client";

import SettingsMenu from "@/components/settings-menu";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser, useClerk, RedirectToSignIn } from "@clerk/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import { supabase } from "@/lib/supabaseClient";
import posthog from "posthog-js";

// ── Types ────────────────────────────────────────────────────────────────────

type Card = {
  id: string;
  name: string;
  set: string;
  year: number | null;
};

type HoldingRow = {
  id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  grade: string;
  qty: number;
  price_paid_usd: number;
  acquired_on: string | null;
  venue: string | null;
};

type MarketRow = {
  canonical_slug: string | null;
  printing_id: string | null;
  grade: string;
  price_usd: number;
};

const VALID_GRADES = ["RAW", "PSA9", "PSA10"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function identityKey(row: { printing_id: string | null; canonical_slug: string | null; grade: string }) {
  return `${row.printing_id ?? row.canonical_slug ?? "unknown"}::${row.grade}`;
}

function cardLookupKey(row: { canonical_slug: string | null }) {
  return row.canonical_slug ?? "";
}

function money(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(dateString: string | null) {
  if (!dateString) return "Unknown date";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Inner component (needs useSearchParams → must be inside Suspense) ───────

function PortfolioInner() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [onboardingRedirect, setOnboardingRedirect] = useState(false);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);

  const [cards, setCards] = useState<Card[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [marketPrices, setMarketPrices] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState(false);
  const [addSaving, setAddSaving] = useState(false);

  const [cardId, setCardId] = useState<string>("");
  const [grade, setGrade] = useState<string>("RAW");
  const [qty, setQty] = useState<number>(1);
  const [pricePaid, setPricePaid] = useState<number>(100);
  const [acquiredOn, setAcquiredOn] = useState<string>("");
  const [venue, setVenue] = useState<string>("");

  const modalRef = useRef<HTMLDivElement | null>(null);

  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  const cardById = useMemo(() => {
    const m = new Map<string, Card>();
    cards.forEach((c) => m.set(c.id, c));
    return m;
  }, [cards]);

  const positions = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string;
        canonical_slug: string | null;
        printing_id: string | null;
        grade: string;
        lots: HoldingRow[];
        totalQty: number;
        costBasis: number;
        avgCost: number;
      }
    >();

    for (const h of holdings) {
      const key = identityKey(h);
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          canonical_slug: h.canonical_slug,
          printing_id: h.printing_id,
          grade: h.grade,
          lots: [],
          totalQty: 0,
          costBasis: 0,
          avgCost: 0,
        });
      }
      const g = grouped.get(key);
      if (!g) continue;
      g.lots.push(h);
      g.totalQty += h.qty;
      g.costBasis += h.qty * Number(h.price_paid_usd);
    }

    for (const g of grouped.values()) {
      g.avgCost = g.totalQty > 0 ? g.costBasis / g.totalQty : 0;
    }

    const arr = Array.from(grouped.values());
    arr.sort((a, b) => {
      const am = (marketPrices[a.key] ?? 0) * a.totalQty;
      const bm = (marketPrices[b.key] ?? 0) * b.totalQty;
      if (bm !== am) return bm - am;
      return b.costBasis - a.costBasis;
    });

    return arr;
  }, [holdings, marketPrices]);

  const totalCost = positions.reduce((s, p) => s + p.costBasis, 0);
  const totalMarket = positions.reduce(
    (s, p) => s + (marketPrices[p.key] ?? 0) * p.totalQty,
    0
  );
  const totalPnL = totalMarket - totalCost;
  const totalPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  const salesHistory = useMemo(() => {
    return [...holdings]
      .sort((a, b) => {
        const ad = a.acquired_on ? new Date(a.acquired_on).getTime() : 0;
        const bd = b.acquired_on ? new Date(b.acquired_on).getTime() : 0;
        return bd - ad;
      })
      .slice(0, 8)
      .map((lot) => {
        const key = identityKey(lot);
        const marketPrice = marketPrices[key] ?? 0;
        const costEach = Number(lot.price_paid_usd);
        return {
          ...lot,
          title: cardById.get(cardLookupKey(lot))?.name ?? "Unknown card",
          spread: marketPrice - costEach,
          marketPrice,
        };
      });
  }, [holdings, marketPrices, cardById]);

  const psaStats = useMemo(() => {
    let totalUnits = 0;
    let gradedUnits = 0;
    let psa10Units = 0;
    let psa9Units = 0;

    for (const h of holdings) {
      totalUnits += h.qty;
      if (h.grade === "PSA10") psa10Units += h.qty;
      if (h.grade === "PSA9") psa9Units += h.qty;
      if (h.grade.startsWith("PSA")) gradedUnits += h.qty;
    }

    const psa10Rate = gradedUnits > 0 ? (psa10Units / gradedUnits) * 100 : 0;
    const gradingCoverage = totalUnits > 0 ? (gradedUnits / totalUnits) * 100 : 0;

    return { totalUnits, gradedUnits, psa10Units, psa9Units, psa10Rate, gradingCoverage };
  }, [holdings]);

  // ── Data fetching ───────────────────────────────────────────────────────

  const fetchHoldings = useCallback(async () => {
    setHoldingsError(null);
    try {
      const res = await fetch("/api/holdings");
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setHoldings((json.holdings ?? []) as HoldingRow[]);
    } catch (err) {
      setHoldingsError(err instanceof Error ? err.message : "Failed to load holdings.");
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);

    // Public reads — cards and market prices (anon key, no auth)
    const [, holdingsResult, ] = await Promise.allSettled([
      (async () => {
        const { data: cardsData } = await supabase
          .from("canonical_cards")
          .select("slug, canonical_name, set_name, year")
          .order("year", { ascending: true })
          .order("set_name", { ascending: true })
          .order("canonical_name", { ascending: true });

        const list = ((cardsData ?? []) as Array<{
          slug: string;
          canonical_name: string;
          set_name: string | null;
          year: number | null;
        }>).map((row) => ({
          id: row.slug,
          name: row.canonical_name,
          set: row.set_name ?? "Unknown set",
          year: row.year,
        })) as Card[];
        setCards(list);
        setCardId((prev) => (prev || list[0]?.id || ""));
      })(),
      fetchHoldings(),
      (async () => {
        const { data: marketData } = await supabase
          .from("market_snapshots")
          .select("canonical_slug, printing_id, grade, price_usd")
          .eq("source", "tcgplayer");

        const priceMap: Record<string, number> = {};
        (marketData ?? []).forEach((row: MarketRow) => {
          priceMap[identityKey(row)] = Number(row.price_usd);
        });
        setMarketPrices(priceMap);
      })(),
    ]);

    // Surface holdings error even when other fetches succeed
    if (holdingsResult.status === "rejected") {
      setHoldingsError(holdingsResult.reason?.message ?? "Failed to load holdings.");
    }

    setLoading(false);
  }, [fetchHoldings]);

  useEffect(() => {
    if (!isLoaded || !user) return;

    // Pre-check: redirect to onboarding if user has no handle
    (async () => {
      try {
        const res = await fetch("/api/me");
        if (res.ok) {
          const json = await res.json();
          if (!json.user?.onboarded) {
            const qs = searchParams.toString();
            const returnUrl = pathname + (qs ? `?${qs}` : "");
            setOnboardingRedirect(true);
            window.location.href = `/onboarding/handle?return_to=${encodeURIComponent(returnUrl)}`;
            return;
          }
        }
      } catch {
        // Non-fatal — API gate (requireOnboarded) is the real guard
      }
      loadAll();
    })();
  }, [isLoaded, user, loadAll, pathname, searchParams]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    if (addOpen) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addOpen]);

  // ── Loading state ─────────────────────────────────────────────────────

  if (!isLoaded) {
    return (
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
            <p className="text-sm text-white/50">Loading account...</p>
          </div>
        </div>
      </PageShell>
    );
  }

  // ── Signed-out redirect ───────────────────────────────────────────────

  if (!user) {
    const qs = searchParams.toString();
    const returnUrl = pathname + (qs ? `?${qs}` : "");
    return <RedirectToSignIn redirectUrl={returnUrl} />;
  }

  // ── Redirecting to onboarding ────────────────────────────────────────

  if (onboardingRedirect) {
    return (
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
            <p className="text-sm text-white/50">Setting up your account...</p>
          </div>
        </div>
      </PageShell>
    );
  }

  // ── Signed-in: data still loading ─────────────────────────────────────

  if (loading) {
    return (
      <PageShell>
        <div className="px-4 py-6 sm:px-6 lg:px-10">
          <div className="mx-auto max-w-[1200px] space-y-4">
            <div className="h-8 w-48 animate-pulse rounded-xl bg-white/10" />
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="h-64 animate-pulse rounded-3xl bg-white/5" />
              <div className="h-64 animate-pulse rounded-3xl bg-white/5" />
            </div>
            <div className="h-48 animate-pulse rounded-3xl bg-white/5" />
          </div>
        </div>
      </PageShell>
    );
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  function openAddLot() {
    setAddErr(null);
    setAddSuccess(false);
    if (!cardId && cards.length > 0) setCardId(cards[0].id);
    setAddOpen(true);
    setTimeout(() => modalRef.current?.focus(), 0);
  }

  async function addLot(e: React.FormEvent) {
    e.preventDefault();
    setAddErr(null);
    setAddSuccess(false);
    setAddSaving(true);

    // Client-side validation
    if (!cardId) {
      setAddErr("Pick a card.");
      setAddSaving(false);
      return;
    }
    if (!VALID_GRADES.includes(grade as typeof VALID_GRADES[number])) {
      setAddErr("Select a valid grade.");
      setAddSaving(false);
      return;
    }
    const intQty = Math.floor(qty);
    if (!Number.isFinite(intQty) || intQty < 1) {
      setAddErr("Qty must be a positive whole number.");
      setAddSaving(false);
      return;
    }
    if (!Number.isFinite(pricePaid) || pricePaid < 0) {
      setAddErr("Price paid must be a non-negative number.");
      setAddSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_slug: cardId,
          grade,
          qty: intQty,
          price_paid_usd: pricePaid,
          acquired_on: acquiredOn || null,
          venue: venue || null,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.ok) {
        setAddErr(json.error ?? "Failed to add lot.");
        setAddSaving(false);
        return;
      }
    } catch (err) {
      posthog.captureException(err);
      setAddErr("Network error. Check your connection and try again.");
      setAddSaving(false);
      return;
    }

    posthog.capture("holding_added", {
      canonical_slug: cardId,
      grade,
      qty: intQty,
      price_paid_usd: pricePaid,
      venue: venue || null,
    });

    // Success — reset form, show feedback, re-fetch
    setQty(1);
    setAcquiredOn("");
    setVenue("");
    setAddSuccess(true);
    setAddSaving(false);

    await fetchHoldings();

    // Auto-dismiss success after 2s, then close modal
    setTimeout(() => {
      setAddSuccess(false);
      setAddOpen(false);
    }, 1200);
  }

  const pnlClass = totalPnL >= 0 ? "text-emerald-600" : "text-rose-600";

  return (
    <PageShell>
      <div className="px-4 py-6 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-[1200px] rounded-[2rem] border border-[#1E1E1E] bg-[#0A0A0A] p-3 sm:p-5 shadow-[0_35px_80px_rgba(0,0,0,0.55)]">
        <div className="relative overflow-hidden rounded-[1.8rem] border border-white/[0.08] bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,0.18),transparent_34%),radial-gradient(circle_at_top_right,rgba(79,70,229,0.14),transparent_30%),linear-gradient(180deg,#111827_0%,#0A0A0A_78%)] p-5 sm:p-7">
          <div className="absolute -left-16 -top-16 h-64 w-64 rounded-full bg-sky-400/10 blur-3xl" />
          <div className="absolute -right-20 -bottom-20 h-72 w-72 rounded-full bg-indigo-300/10 blur-3xl" />

          <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.06] font-bold text-white">PA</div>
              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-[#8BA3C7]">Portfolio Desk</p>
                <p className="font-semibold text-white">PopAlpha Portfolio</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SettingsMenu />
              <button
                onClick={openAddLot}
                className="rounded-xl border border-white/[0.08] bg-white/[0.06] px-4 py-2 text-sm font-medium text-white transition hover:bg-white/[0.1]"
              >
                Add lot
              </button>
              <button
                onClick={() => signOut({ redirectUrl: "/" })}
                className="rounded-xl border border-white/[0.08] bg-white px-4 py-2 text-sm font-semibold text-[#0A0A0A] transition hover:bg-white/90"
              >
                Sign out
              </button>
            </div>
          </div>

          {/* Holdings error banner */}
          {holdingsError && (
            <div className="relative z-10 mt-4 flex items-center justify-between gap-3 rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm">
              <span className="text-rose-200">Failed to load holdings: {holdingsError}</span>
              <button
                onClick={fetchHoldings}
                className="shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/[0.1]"
              >
                Retry
              </button>
            </div>
          )}

          <div className="relative z-10 mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-sm">
              <p className="text-sm text-[#D7DBE6]">Collection Performance</p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-[#8A8A8A]">Total Cost</p>
                  <p className="mt-1 text-xl font-semibold text-white">${money(totalCost)}</p>
                </div>
                <div>
                  <p className="text-[#8A8A8A]">Market Value</p>
                  <p className="mt-1 text-xl font-semibold text-white">${money(totalMarket)}</p>
                </div>
                <div>
                  <p className="text-[#8A8A8A]">Unrealized P/L</p>
                  <p className={`mt-1 text-xl font-semibold ${pnlClass}`}>${money(totalPnL)}</p>
                </div>
                <div>
                  <p className="text-[#8A8A8A]">P/L %</p>
                  <p className={`mt-1 text-xl font-semibold ${pnlClass}`}>{totalPct.toFixed(2)}%</p>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/[0.08] bg-black/20 p-3">
                  <p className="text-xs text-[#8A8A8A]">PSA Graded Units</p>
                  <p className="mt-1 text-2xl font-semibold text-white">{psaStats.gradedUnits}</p>
                </div>
                <div className="rounded-2xl border border-white/[0.08] bg-black/20 p-3">
                  <p className="text-xs text-[#8A8A8A]">PSA10 Count</p>
                  <p className="mt-1 text-2xl font-semibold text-white">{psaStats.psa10Units}</p>
                </div>
                <div className="col-span-2 rounded-2xl border border-white/[0.08] bg-black/20 p-3 sm:col-span-1">
                  <p className="text-xs text-[#8A8A8A]">PSA10 Rate</p>
                  <p className="mt-1 text-2xl font-semibold text-white">{psaStats.psa10Rate.toFixed(1)}%</p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-sm">
              <p className="text-sm text-[#8A8A8A]">Account Snapshot</p>
              <h2 className="mt-2 text-3xl font-bold leading-tight text-white">{email ?? "Signed in user"}</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-black/20 p-3">
                  <span className="text-[#8A8A8A]">Sales History Rows</span>
                  <span className="font-semibold text-white">{salesHistory.length}</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-black/20 p-3">
                  <span className="text-[#8A8A8A]">Total Units</span>
                  <span className="font-semibold text-white">{psaStats.totalUnits}</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-black/20 p-3">
                  <span className="text-[#8A8A8A]">Grading Coverage</span>
                  <span className="font-semibold text-white">{psaStats.gradingCoverage.toFixed(1)}%</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-black/20 p-3">
                  <span className="text-[#8A8A8A]">PSA9 Count</span>
                  <span className="font-semibold text-white">{psaStats.psa9Units}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="relative z-10 mt-6 rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-white">Sales History</h3>
                <p className="text-xs text-[#8A8A8A]">Most recent lot activity with PSA-aware spread tracking.</p>
              </div>
              <span className="text-xs text-[#8A8A8A]">Latest 8 rows</span>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm text-[#D7DBE6]">
                <thead className="text-xs uppercase text-[#8A8A8A]">
                  <tr>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Card</th>
                    <th className="py-2 pr-4">Grade</th>
                    <th className="py-2 pr-4">Qty</th>
                    <th className="py-2 pr-4">Cost / Unit</th>
                    <th className="py-2 pr-4">Market / Unit</th>
                    <th className="py-2 pr-4">Spread</th>
                    <th className="py-2">Venue</th>
                  </tr>
                </thead>
                <tbody>
                  {salesHistory.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-5 text-center text-[#8A8A8A]">
                        No sales history yet. Click <span className="font-semibold">Add lot</span> to create your first row.
                      </td>
                    </tr>
                  ) : (
                    salesHistory.map((row) => (
                      <tr key={row.id} className="border-t border-white/[0.06]">
                        <td className="py-3 pr-4">{formatDate(row.acquired_on)}</td>
                        <td className="py-3 pr-4">{row.title}</td>
                        <td className="py-3 pr-4">{row.grade}</td>
                        <td className="py-3 pr-4">{row.qty}</td>
                        <td className="py-3 pr-4">${money(Number(row.price_paid_usd))}</td>
                        <td className="py-3 pr-4">${money(row.marketPrice)}</td>
                        <td className={`py-3 pr-4 font-semibold ${row.spread >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                          {row.spread >= 0 ? "+" : ""}${money(row.spread)}
                        </td>
                        <td className="py-3">{row.venue ?? "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="relative z-10 mt-4 rounded-3xl border border-white/[0.08] bg-white/[0.03] p-4 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Positions</h3>
              <span className="text-xs text-[#8A8A8A]">{positions.length} tracked</span>
            </div>
            <div className="mt-3 space-y-2">
              {positions.map((p) => {
                const market = marketPrices[p.key] ?? 0;
                const marketValue = market * p.totalQty;
                const pnl = marketValue - p.costBasis;
                const c = cardById.get(cardLookupKey(p));
                return (
                  <div key={p.key} className="rounded-2xl border border-white/[0.08] bg-black/20">
                    <button
                      onClick={() => setExpanded(expanded === p.key ? null : p.key)}
                      className="w-full px-4 py-3 text-left"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-white">{c?.name ?? p.canonical_slug ?? "Unknown card"}</p>
                          <p className="text-xs text-[#8A8A8A]">{c ? `${c.set} • ${c.year ?? "—"}` : "Card"} • {p.grade}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-[#D7DBE6]">Qty {p.totalQty}</p>
                          <p className={`text-sm font-semibold ${pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                            {pnl >= 0 ? "+" : ""}${money(pnl)}
                          </p>
                        </div>
                      </div>
                    </button>
                    {expanded === p.key && (
                      <div className="border-t border-white/[0.06] px-4 py-3 text-xs text-[#C8CDD8]">
                        Avg cost ${money(p.avgCost)} • Market ${money(market)} • Basis ${money(p.costBasis)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {addOpen && (
        <div
          className="fixed inset-0 z-[60]"
          aria-hidden={false}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAddOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />

          <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center">
            <div
              ref={modalRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              className="relative w-full sm:max-w-lg outline-none"
            >
              <div className="translate-y-0 rounded-t-3xl border border-white/[0.08] bg-[#0F1117] px-5 py-5 text-white shadow-[0_35px_80px_rgba(0,0,0,0.5)] sm:rounded-3xl sm:p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">Add Lot</h3>
                    <p className="mt-1 text-xs text-[#8A8A8A]">
                      This creates a new row in your sales history and position tracking.
                    </p>
                  </div>
                  <button
                    onClick={() => setAddOpen(false)}
                    className="grid h-9 w-9 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.04] transition hover:bg-white/[0.08]"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                {addSuccess && (
                  <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                    Lot added successfully.
                  </div>
                )}

                {addErr && (
                  <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                    {addErr}
                  </div>
                )}

                <form onSubmit={addLot} className="mt-5 space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-[#B8C1D6]">Card</label>
                    <select
                      value={cardId}
                      onChange={(e) => setCardId(e.target.value)}
                      className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/10"
                    >
                      {cards.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.set} {c.year ?? "—"})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-[#B8C1D6]">Grade</label>
                      <select
                        value={grade}
                        onChange={(e) => setGrade(e.target.value)}
                        className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/10"
                      >
                        {VALID_GRADES.map((g) => (
                          <option key={g} value={g}>{g}</option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-[#B8C1D6]">Qty</label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={qty}
                        onChange={(e) => setQty(Number(e.target.value))}
                        className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/10"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-[#B8C1D6]">Price paid (per unit)</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={pricePaid}
                        onChange={(e) => setPricePaid(Number(e.target.value))}
                        className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/10"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-[#B8C1D6]">Acquired on (optional)</label>
                      <input
                        type="date"
                        value={acquiredOn}
                        onChange={(e) => setAcquiredOn(e.target.value)}
                        className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/10"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-[#B8C1D6]">Venue (optional)</label>
                    <input
                      value={venue}
                      onChange={(e) => setVenue(e.target.value)}
                      placeholder="eBay, local shop, WhatNot…"
                      className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3 py-3 text-sm text-white placeholder:text-[#666] focus:outline-none focus:ring-2 focus:ring-white/10"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setAddOpen(false)}
                      className="rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-white transition hover:bg-white/[0.08]"
                    >
                      Cancel
                    </button>

                    <button
                      type="submit"
                      disabled={addSaving}
                      className="rounded-2xl bg-white px-5 py-3 text-sm font-medium text-[#0A0A0A] transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {addSaving ? "Saving…" : "Add Lot"}
                    </button>
                  </div>
                </form>
              </div>

              <div className="absolute -top-3 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-white/60 sm:hidden" />
            </div>
          </div>
        </div>
      )}
      </div>
    </PageShell>
  );
}

// ── Exported wrapper (Suspense boundary for useSearchParams) ─────────────

export default function PortfolioClient() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <div className="flex min-h-[60vh] items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        </PageShell>
      }
    >
      <PortfolioInner />
    </Suspense>
  );
}
