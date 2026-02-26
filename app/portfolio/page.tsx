"use client";

import SettingsMenu from "@/components/settings-menu";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Card = {
  id: string;
  name: string;
  set: string;
  year: number;
};

type HoldingRow = {
  id: string;
  card_id: string;
  grade: string;
  qty: number;
  price_paid_usd: number;
  acquired_on: string | null;
  venue: string | null;
};

type MarketRow = {
  card_id: string;
  grade: string;
  price_usd: number;
};

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

export default function PortfolioPage() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);

  const [cards, setCards] = useState<Card[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [marketPrices, setMarketPrices] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  const [cardId, setCardId] = useState<string>("");
  const [grade, setGrade] = useState<string>("RAW");
  const [qty, setQty] = useState<number>(1);
  const [pricePaid, setPricePaid] = useState<number>(100);
  const [acquiredOn, setAcquiredOn] = useState<string>("");
  const [venue, setVenue] = useState<string>("");

  const modalRef = useRef<HTMLDivElement | null>(null);

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
        card_id: string;
        grade: string;
        lots: HoldingRow[];
        totalQty: number;
        costBasis: number;
        avgCost: number;
      }
    >();

    for (const h of holdings) {
      const key = `${h.card_id}::${h.grade}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          card_id: h.card_id,
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
        const key = `${lot.card_id}::${lot.grade}`;
        const marketPrice = marketPrices[key] ?? 0;
        const costEach = Number(lot.price_paid_usd);
        return {
          ...lot,
          title: cardById.get(lot.card_id)?.name ?? "Unknown card",
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

    return {
      totalUnits,
      gradedUnits,
      psa10Units,
      psa9Units,
      psa10Rate,
      gradingCoverage,
    };
  }, [holdings]);

  async function loadAll() {
    setLoading(true);

    const { data: sessData } = await supabase.auth.getSession();
    if (!sessData.session) {
      window.location.href = "/login";
      return;
    }

    setEmail(sessData.session.user.email ?? null);

    const { data: cardsData } = await supabase
      .from("cards")
      .select("id, name, set, year")
      .order("year", { ascending: true })
      .order("set", { ascending: true })
      .order("name", { ascending: true });

    const list = (cardsData ?? []) as Card[];
    setCards(list);

    if (!cardId && list.length > 0) setCardId(list[0].id);

    const { data: holdData } = await supabase
      .from("holdings")
      .select("id, card_id, grade, qty, price_paid_usd, acquired_on, venue")
      .order("created_at", { ascending: false });

    setHoldings((holdData ?? []) as HoldingRow[]);

    const { data: marketData } = await supabase
      .from("market_snapshots")
      .select("card_id, grade, price_usd")
      .eq("source", "tcgplayer");

    const priceMap: Record<string, number> = {};
    (marketData ?? []).forEach((row: MarketRow) => {
      priceMap[`${row.card_id}::${row.grade}`] = Number(row.price_usd);
    });
    setMarketPrices(priceMap);

    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    if (addOpen) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addOpen]);

  function openAddLot() {
    setAddErr(null);
    if (!cardId && cards.length > 0) setCardId(cards[0].id);
    setAddOpen(true);
    setTimeout(() => modalRef.current?.focus(), 0);
  }

  async function addLot(e: React.FormEvent) {
    e.preventDefault();
    setAddErr(null);
    setAddSaving(true);

    const { data: sessData, error: sessErr } = await supabase.auth.getSession();
    if (sessErr) {
      setAddErr(sessErr.message);
      setAddSaving(false);
      return;
    }
    const session = sessData.session;
    if (!session) {
      window.location.href = "/login";
      return;
    }

    if (!cardId) {
      setAddErr("Pick a card.");
      setAddSaving(false);
      return;
    }
    if (!qty || qty < 1) {
      setAddErr("Qty must be at least 1.");
      setAddSaving(false);
      return;
    }
    if (pricePaid < 0) {
      setAddErr("Price paid must be >= 0.");
      setAddSaving(false);
      return;
    }

    const { error } = await supabase.from("holdings").insert({
      user_id: session.user.id,
      card_id: cardId,
      grade,
      qty,
      price_paid_usd: pricePaid,
      acquired_on: acquiredOn ? acquiredOn : null,
      venue: venue ? venue : null,
    });

    if (error) {
      setAddErr(error.message);
      setAddSaving(false);
      return;
    }

    setQty(1);
    setPricePaid(pricePaid);
    setAcquiredOn("");
    setVenue("");

    await loadAll();
    setAddOpen(false);
    setAddSaving(false);
  }

  if (loading) return <div className="p-8">Loading...</div>;

  const pnlClass = totalPnL >= 0 ? "text-emerald-600" : "text-rose-600";

  return (
    <div className="app-shell px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-[1200px] rounded-[2rem] border border-white/20 bg-[#2f2555] p-3 sm:p-5 shadow-[0_35px_80px_rgba(0,0,0,0.55)]">
        <div className="relative overflow-hidden rounded-[1.8rem] border border-white/20 bg-gradient-to-br from-[#a441d6] via-[#6e4ac6] to-[#2f74d0] p-5 sm:p-7">
          <div className="absolute -left-16 -top-16 h-64 w-64 rounded-full bg-orange-400/20 blur-3xl" />
          <div className="absolute -right-20 -bottom-20 h-72 w-72 rounded-full bg-sky-300/20 blur-3xl" />

          <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-white/20 grid place-items-center font-bold">PA</div>
              <div>
                <p className="text-xs text-white/75">Sales Command Center</p>
                <p className="font-semibold">PopAlpha Portfolio</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SettingsMenu />
              <button
                onClick={openAddLot}
                className="rounded-xl bg-white/20 px-4 py-2 text-sm font-medium hover:bg-white/30 transition"
              >
                Add lot
              </button>
              <button
                onClick={async () => {
                  await supabase.auth.signOut();
                  window.location.href = "/login";
                }}
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#2b2553] hover:bg-white/90 transition"
              >
                Sign out
              </button>
            </div>
          </div>

          <div className="relative z-10 mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="rounded-3xl border border-white/20 bg-black/20 p-5">
              <p className="text-sm text-white/80">Collection Performance</p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-white/60">Total Cost</p>
                  <p className="mt-1 text-xl font-semibold">${money(totalCost)}</p>
                </div>
                <div>
                  <p className="text-white/60">Market Value</p>
                  <p className="mt-1 text-xl font-semibold">${money(totalMarket)}</p>
                </div>
                <div>
                  <p className="text-white/60">Unrealized P/L</p>
                  <p className={`mt-1 text-xl font-semibold ${pnlClass}`}>${money(totalPnL)}</p>
                </div>
                <div>
                  <p className="text-white/60">P/L %</p>
                  <p className={`mt-1 text-xl font-semibold ${pnlClass}`}>{totalPct.toFixed(2)}%</p>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3">
                  <p className="text-xs text-white/70">PSA Graded Units</p>
                  <p className="mt-1 text-2xl font-semibold">{psaStats.gradedUnits}</p>
                </div>
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3">
                  <p className="text-xs text-white/70">PSA10 Count</p>
                  <p className="mt-1 text-2xl font-semibold">{psaStats.psa10Units}</p>
                </div>
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3 col-span-2 sm:col-span-1">
                  <p className="text-xs text-white/70">PSA10 Rate</p>
                  <p className="mt-1 text-2xl font-semibold">{psaStats.psa10Rate.toFixed(1)}%</p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/20 bg-black/20 p-5">
              <p className="text-sm text-white/70">Account Snapshot</p>
              <h2 className="mt-2 text-3xl font-bold leading-tight">{email ?? "Signed in user"}</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3 flex items-center justify-between">
                  <span className="text-white/70">Sales History Rows</span>
                  <span className="font-semibold">{salesHistory.length}</span>
                </div>
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3 flex items-center justify-between">
                  <span className="text-white/70">Total Units</span>
                  <span className="font-semibold">{psaStats.totalUnits}</span>
                </div>
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3 flex items-center justify-between">
                  <span className="text-white/70">Grading Coverage</span>
                  <span className="font-semibold">{psaStats.gradingCoverage.toFixed(1)}%</span>
                </div>
                <div className="rounded-2xl border border-white/20 bg-white/10 p-3 flex items-center justify-between">
                  <span className="text-white/70">PSA9 Count</span>
                  <span className="font-semibold">{psaStats.psa9Units}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="relative z-10 mt-6 rounded-3xl border border-white/20 bg-black/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">Sales History</h3>
                <p className="text-xs text-white/65">Most recent lot activity with PSA-aware spread tracking.</p>
              </div>
              <span className="text-xs text-white/70">Latest 8 rows</span>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase text-white/65">
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
                      <td colSpan={8} className="py-5 text-center text-white/65">
                        No sales history yet. Click <span className="font-semibold">Add lot</span> to create your first row.
                      </td>
                    </tr>
                  ) : (
                    salesHistory.map((row) => (
                      <tr key={row.id} className="border-t border-white/10">
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

          <div className="relative z-10 mt-4 rounded-3xl border border-white/20 bg-black/20 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Positions</h3>
              <span className="text-xs text-white/70">{positions.length} tracked</span>
            </div>
            <div className="mt-3 space-y-2">
              {positions.map((p) => {
                const market = marketPrices[p.key] ?? 0;
                const marketValue = market * p.totalQty;
                const pnl = marketValue - p.costBasis;
                const c = cardById.get(p.card_id);
                return (
                  <div key={p.key} className="rounded-2xl border border-white/15 bg-white/5">
                    <button
                      onClick={() => setExpanded(expanded === p.key ? null : p.key)}
                      className="w-full px-4 py-3 text-left"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold">{c?.name ?? p.card_id}</p>
                          <p className="text-xs text-white/65">{c ? `${c.set} • ${c.year}` : "Card"} • {p.grade}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm">Qty {p.totalQty}</p>
                          <p className={`text-sm font-semibold ${pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                            {pnl >= 0 ? "+" : ""}${money(pnl)}
                          </p>
                        </div>
                      </div>
                    </button>
                    {expanded === p.key && (
                      <div className="border-t border-white/10 px-4 py-3 text-xs text-white/80">
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
              <div className="glass rounded-t-3xl sm:rounded-3xl px-5 py-5 sm:p-6 border border-neutral-200/50 dark:border-neutral-800/60 translate-y-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">Add Lot</h3>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      This creates a new row in your sales history and position tracking.
                    </p>
                  </div>
                  <button
                    onClick={() => setAddOpen(false)}
                    className="h-9 w-9 rounded-2xl grid place-items-center hover:bg-neutral-100/70 dark:hover:bg-neutral-800/60 transition"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                {addErr && (
                  <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
                    {addErr}
                  </div>
                )}

                <form onSubmit={addLot} className="mt-5 space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Card</label>
                    <select
                      value={cardId}
                      onChange={(e) => setCardId(e.target.value)}
                      className="w-full rounded-2xl px-3 py-3 text-sm bg-white/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-800/70 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                    >
                      {cards.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.set} {c.year})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Grade</label>
                      <select
                        value={grade}
                        onChange={(e) => setGrade(e.target.value)}
                        className="w-full rounded-2xl px-3 py-3 text-sm bg-white/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-800/70 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      >
                        <option value="RAW">RAW</option>
                        <option value="PSA9">PSA9</option>
                        <option value="PSA10">PSA10</option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Qty</label>
                      <input
                        type="number"
                        min={1}
                        value={qty}
                        onChange={(e) => setQty(Number(e.target.value))}
                        className="w-full rounded-2xl px-3 py-3 text-sm bg-white/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-800/70 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Price paid (per unit)</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={pricePaid}
                        onChange={(e) => setPricePaid(Number(e.target.value))}
                        className="w-full rounded-2xl px-3 py-3 text-sm bg-white/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-800/70 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Acquired on (optional)</label>
                      <input
                        type="date"
                        value={acquiredOn}
                        onChange={(e) => setAcquiredOn(e.target.value)}
                        className="w-full rounded-2xl px-3 py-3 text-sm bg-white/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-800/70 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Venue (optional)</label>
                    <input
                      value={venue}
                      onChange={(e) => setVenue(e.target.value)}
                      placeholder="eBay, local shop, WhatNot…"
                      className="w-full rounded-2xl px-3 py-3 text-sm bg-white/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-800/70 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setAddOpen(false)}
                      className="px-4 py-3 rounded-2xl text-sm border border-neutral-200/70 bg-white/60 hover:bg-white/80 transition dark:border-neutral-800/70 dark:bg-neutral-900/50 dark:hover:bg-neutral-900/70"
                    >
                      Cancel
                    </button>

                    <button
                      type="submit"
                      disabled={addSaving}
                      className="px-5 py-3 rounded-2xl text-sm font-medium bg-neutral-900 text-white hover:bg-neutral-800 transition disabled:opacity-60 disabled:cursor-not-allowed dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
                    >
                      {addSaving ? "Saving…" : "Add Lot"}
                    </button>
                  </div>
                </form>
              </div>

              <div className="sm:hidden absolute -top-3 left-1/2 -translate-x-1/2 h-1.5 w-12 rounded-full bg-white/60 dark:bg-neutral-800/80" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
