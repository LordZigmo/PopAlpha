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

export default function PortfolioPage() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);

  const [cards, setCards] = useState<Card[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [marketPrices, setMarketPrices] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  // Add Lot modal
  const [addOpen, setAddOpen] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  // form fields
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
      const g = grouped.get(key)!;
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

    // default selected card
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

  // close modal on ESC
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
    // focus the modal container next tick
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

    // reset lightweight fields; keep card/grade for speed
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
  const pnlBadge =
    totalPnL >= 0
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
      : "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20";

  return (
    <div className="app-shell">
      {/* Sticky glass header */}
      <div className="sticky top-0 z-40">
        <div className="glass mx-auto max-w-[1020px] px-4 sm:px-6 py-4 mt-4 rounded-3xl">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl grid place-items-center font-semibold text-sm bg-neutral-900 text-white dark:bg-neutral-200 dark:text-neutral-900">
                  PA
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-lg sm:text-xl font-semibold leading-tight">
                      PopAlpha
                    </h1>
                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-neutral-200/70 dark:border-neutral-800/70 text-neutral-600 dark:text-neutral-300 bg-white/60 dark:bg-neutral-900/50">
                      TCG anchor
                    </span>
                  </div>
                  <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 truncate">
                    {email}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <SettingsMenu />
              <button
                onClick={async () => {
                  await supabase.auth.signOut();
                  window.location.href = "/login";
                }}
                className="text-sm px-4 py-2 rounded-2xl bg-neutral-900 text-white hover:bg-neutral-800 transition
                           dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Sign out
              </button>
            </div>
          </div>

          {/* mini subheader */}
          <div className="mt-4 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>Portfolio</span>
            <span>Updated from snapshots</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-[1020px] px-4 sm:px-6 py-6 space-y-6 pb-24">
        {/* KPI row */}
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="glow-card lift card rounded-3xl p-5">
            <p className="text-xs font-medium tracking-wide text-neutral-500 dark:text-neutral-400">
              COST BASIS
            </p>
            <p className="mt-2 text-2xl font-semibold">${money(totalCost)}</p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              What you’ve paid (total)
            </p>
          </div>

          <div className="glow-card lift card rounded-3xl p-5">
            <p className="text-xs font-medium tracking-wide text-neutral-500 dark:text-neutral-400">
              MARKET VALUE
            </p>
            <p className="mt-2 text-2xl font-semibold">${money(totalMarket)}</p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              TCGplayer snapshot
            </p>
          </div>

          <div
            className={`glow-card lift card rounded-3xl p-5 ${
              totalPnL >= 0 ? "pulse-positive" : ""
            }`}
          >
            <p className="text-xs font-medium tracking-wide text-neutral-500 dark:text-neutral-400">
              P / L
            </p>
            <div className="mt-2 flex items-baseline gap-2">
              <p className={`text-2xl font-semibold ${pnlClass}`}>
                ${money(totalPnL)}
              </p>
              <span className={`text-xs px-2 py-1 rounded-full border ${pnlBadge}`}>
                {totalPct.toFixed(2)}%
              </span>
            </div>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Unrealized
            </p>
          </div>
        </div>

        {/* Positions list */}
        <div className="card rounded-3xl overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-200/70 dark:border-neutral-800/70 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Positions</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Tap a card to expand lots
              </p>
            </div>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {positions.length} position{positions.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="p-3 sm:p-4 space-y-3">
            {positions.map((p) => {
              const market = marketPrices[p.key] ?? 0;
              const marketValue = market * p.totalQty;
              const pnl = marketValue - p.costBasis;
              const pnlPct = p.costBasis > 0 ? (pnl / p.costBasis) * 100 : 0;

              const c = cardById.get(p.card_id);
              const title = c ? c.name : p.card_id;
              const subtitle = c ? `${c.set} • ${c.year}` : "—";

              const rowPnlClass = pnl >= 0 ? "text-emerald-600" : "text-rose-600";

              return (
                <div
                  key={p.key}
                  className="glow-card lift rounded-3xl overflow-hidden border border-neutral-200/70 dark:border-neutral-800/70 bg-white/55 dark:bg-neutral-900/40"
                >
                  <button
                    onClick={() => setExpanded(expanded === p.key ? null : p.key)}
                    className="w-full text-left px-4 py-4 hover:bg-white/40 dark:hover:bg-neutral-900/60 transition"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold truncate">{title}</div>
                          <span className="text-[11px] px-2 py-0.5 rounded-full border border-neutral-200/70 dark:border-neutral-800/70 text-neutral-600 dark:text-neutral-300 bg-white/50 dark:bg-neutral-900/40">
                            {p.grade}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 truncate">
                          {subtitle}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className={`text-sm font-semibold ${rowPnlClass}`}>
                          ${money(pnl)}{" "}
                          <span className="text-xs">({pnlPct.toFixed(1)}%)</span>
                        </div>
                        <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                          {p.totalQty} × {market ? `$${money(market)}` : "—"}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded-2xl bg-white/45 dark:bg-neutral-900/40 border border-neutral-200/60 dark:border-neutral-800/60 p-2">
                        <div className="text-neutral-500 dark:text-neutral-400">
                          Avg Paid
                        </div>
                        <div className="mt-1 font-medium">${money(p.avgCost)}</div>
                      </div>
                      <div className="rounded-2xl bg-white/45 dark:bg-neutral-900/40 border border-neutral-200/60 dark:border-neutral-800/60 p-2">
                        <div className="text-neutral-500 dark:text-neutral-400">
                          Cost
                        </div>
                        <div className="mt-1 font-medium">${money(p.costBasis)}</div>
                      </div>
                      <div className="rounded-2xl bg-white/45 dark:bg-neutral-900/40 border border-neutral-200/60 dark:border-neutral-800/60 p-2">
                        <div className="text-neutral-500 dark:text-neutral-400">
                          Market
                        </div>
                        <div className="mt-1 font-medium">
                          {market ? `$${money(marketValue)}` : "—"}
                        </div>
                      </div>
                    </div>
                  </button>

                  {expanded === p.key && (
                    <div className="px-4 pb-4 pt-0 border-t border-neutral-200/70 dark:border-neutral-800/70 bg-white/35 dark:bg-neutral-950/25">
                      <div className="pt-3 text-[11px] font-semibold tracking-wide text-neutral-500 dark:text-neutral-400">
                        LOTS
                      </div>

                      <div className="mt-2 space-y-2">
                        {p.lots.map((lot) => (
                          <div
                            key={lot.id}
                            className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200/70 bg-white/60 p-3
                                       dark:border-neutral-800/70 dark:bg-neutral-900/55"
                          >
                            <div className="text-sm">
                              <span className="font-medium">{lot.qty}×</span> @ $
                              {money(Number(lot.price_paid_usd))}
                              {lot.venue ? (
                                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                                  • {lot.venue}
                                </span>
                              ) : null}
                            </div>
                            <div className="text-xs text-neutral-500 dark:text-neutral-400">
                              {lot.acquired_on ?? "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {positions.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
                No positions yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Floating Action Button */}
      <button
        onClick={openAddLot}
        className="fixed bottom-6 right-6 z-50 h-12 px-4 rounded-2xl flex items-center gap-2
                   bg-neutral-900 text-white shadow-xl hover:bg-neutral-800 transition
                   dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
        aria-label="Add lot"
      >
        <span className="text-lg leading-none">＋</span>
        <span className="text-sm font-medium">Add Lot</span>
      </button>

      {/* Add Lot Modal (bottom sheet on mobile, dialog on desktop) */}
      {addOpen && (
        <div
          className="fixed inset-0 z-[60]"
          aria-hidden={false}
          onMouseDown={(e) => {
            // click outside closes
            if (e.target === e.currentTarget) setAddOpen(false);
          }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />

          {/* Sheet/Dialog */}
          <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center">
            <div
              ref={modalRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              className="relative w-full sm:max-w-lg outline-none"
            >
              <div
                className="glass rounded-t-3xl sm:rounded-3xl px-5 py-5 sm:p-6
                           border border-neutral-200/50 dark:border-neutral-800/60
                           translate-y-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">Add Lot</h3>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      Creates a purchase lot under an existing card + grade.
                    </p>
                  </div>
                  <button
                    onClick={() => setAddOpen(false)}
                    className="h-9 w-9 rounded-2xl grid place-items-center
                               hover:bg-neutral-100/70 dark:hover:bg-neutral-800/60 transition"
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
                    <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      Card
                    </label>
                    <select
                      value={cardId}
                      onChange={(e) => setCardId(e.target.value)}
                      className="w-full rounded-2xl px-3 py-3 text-sm
                                 bg-white/70 dark:bg-neutral-900/50
                                 border border-neutral-200/70 dark:border-neutral-800/70
                                 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
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
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        Grade
                      </label>
                      <select
                        value={grade}
                        onChange={(e) => setGrade(e.target.value)}
                        className="w-full rounded-2xl px-3 py-3 text-sm
                                   bg-white/70 dark:bg-neutral-900/50
                                   border border-neutral-200/70 dark:border-neutral-800/70
                                   focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      >
                        <option value="RAW">RAW</option>
                        <option value="PSA9">PSA9</option>
                        <option value="PSA10">PSA10</option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        Qty
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={qty}
                        onChange={(e) => setQty(Number(e.target.value))}
                        className="w-full rounded-2xl px-3 py-3 text-sm
                                   bg-white/70 dark:bg-neutral-900/50
                                   border border-neutral-200/70 dark:border-neutral-800/70
                                   focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        Price paid (per unit)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={pricePaid}
                        onChange={(e) => setPricePaid(Number(e.target.value))}
                        className="w-full rounded-2xl px-3 py-3 text-sm
                                   bg-white/70 dark:bg-neutral-900/50
                                   border border-neutral-200/70 dark:border-neutral-800/70
                                   focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        Acquired on (optional)
                      </label>
                      <input
                        type="date"
                        value={acquiredOn}
                        onChange={(e) => setAcquiredOn(e.target.value)}
                        className="w-full rounded-2xl px-3 py-3 text-sm
                                   bg-white/70 dark:bg-neutral-900/50
                                   border border-neutral-200/70 dark:border-neutral-800/70
                                   focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      Venue (optional)
                    </label>
                    <input
                      value={venue}
                      onChange={(e) => setVenue(e.target.value)}
                      placeholder="eBay, local shop, WhatNot…"
                      className="w-full rounded-2xl px-3 py-3 text-sm
                                 bg-white/70 dark:bg-neutral-900/50
                                 border border-neutral-200/70 dark:border-neutral-800/70
                                 focus:outline-none focus:ring-2 focus:ring-neutral-900/20 dark:focus:ring-white/15"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setAddOpen(false)}
                      className="px-4 py-3 rounded-2xl text-sm border border-neutral-200/70 bg-white/60 hover:bg-white/80 transition
                                 dark:border-neutral-800/70 dark:bg-neutral-900/50 dark:hover:bg-neutral-900/70"
                    >
                      Cancel
                    </button>

                    <button
                      type="submit"
                      disabled={addSaving}
                      className="px-5 py-3 rounded-2xl text-sm font-medium bg-neutral-900 text-white hover:bg-neutral-800 transition
                                 disabled:opacity-60 disabled:cursor-not-allowed
                                 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
                    >
                      {addSaving ? "Saving…" : "Add Lot"}
                    </button>
                  </div>
                </form>

                <div className="mt-4 text-[11px] text-neutral-500 dark:text-neutral-400">
                  Tip: Keep the same card selected while entering multiple lots.
                </div>
              </div>

              {/* iOS-style grab handle (mobile only) */}
              <div className="sm:hidden absolute -top-3 left-1/2 -translate-x-1/2 h-1.5 w-12 rounded-full bg-white/60 dark:bg-neutral-800/80" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}