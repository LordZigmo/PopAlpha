import { useMemo, useState } from "react";

function toNum(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function ProceedsCalculator() {
  const [offerPrice, setOfferPrice] = useState("");
  const [privateFeePct, setPrivateFeePct] = useState("2");
  const [ebayFeePct, setEbayFeePct] = useState("13.25");
  const [shippingEstimate, setShippingEstimate] = useState("0");

  const calc = useMemo(() => {
    const offer = toNum(offerPrice, 0);
    const privateFee = Math.max(0, toNum(privateFeePct, 2));
    const ebayFee = Math.max(0, toNum(ebayFeePct, 13.25));
    const shipping = Math.max(0, toNum(shippingEstimate, 0));

    if (offer <= 0) {
      return { privateNet: null, ebayNet: null, diff: null, recommendation: "Enter an offer price to compare outcomes." };
    }

    const privateNet = offer * (1 - privateFee / 100) - shipping;
    const ebayNet = offer * (1 - ebayFee / 100) - shipping;
    const diff = privateNet - ebayNet;
    const threshold = Math.max(25, offer * 0.02);
    const recommendation = diff > threshold ? "Prefer private" : "Prefer public / similar";

    return { privateNet, ebayNet, diff, recommendation };
  }, [ebayFeePct, offerPrice, privateFeePct, shippingEstimate]);

  return (
    <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
      <p className="text-app text-sm font-semibold">Net Proceeds Calculator</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="text-muted text-xs">Offer price</span><input value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
        <label className="block"><span className="text-muted text-xs">Private payment fee %</span><input value={privateFeePct} onChange={(e) => setPrivateFeePct(e.target.value)} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
        <label className="block"><span className="text-muted text-xs">eBay fee %</span><input value={ebayFeePct} onChange={(e) => setEbayFeePct(e.target.value)} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
        <label className="block"><span className="text-muted text-xs">Shipping estimate</span><input value={shippingEstimate} onChange={(e) => setShippingEstimate(e.target.value)} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
      </div>
      <div className="mt-4 rounded-[var(--radius-card)] border-app border bg-surface p-3 text-sm">
        <p className="text-app">Private net: <span className="font-semibold tabular-nums">{calc.privateNet === null ? "—" : `$${calc.privateNet.toFixed(2)}`}</span></p>
        <p className="text-app mt-1">eBay net: <span className="font-semibold tabular-nums">{calc.ebayNet === null ? "—" : `$${calc.ebayNet.toFixed(2)}`}</span></p>
        <p className="text-app mt-1">Difference: <span className="font-semibold tabular-nums">{calc.diff === null ? "—" : `$${calc.diff.toFixed(2)}`}</span></p>
        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-positive">{calc.recommendation}</p>
      </div>
    </div>
  );
}
