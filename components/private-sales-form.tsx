export type SaleFormState = {
  soldAt: string;
  price: string;
  fees: string;
  paymentMethod: string;
  notes: string;
};

export default function PrivateSalesForm({
  state,
  onChange,
  onSubmit,
  submitting,
}: {
  state: SaleFormState;
  onChange: (next: SaleFormState) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
      <p className="text-app text-sm font-semibold">Add Private Sale</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label><span className="text-muted text-xs">Sold date</span><input type="date" value={state.soldAt} onChange={(e) => onChange({ ...state, soldAt: e.target.value })} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
        <label><span className="text-muted text-xs">Price (USD)</span><input value={state.price} onChange={(e) => onChange({ ...state, price: e.target.value })} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
        <label><span className="text-muted text-xs">Fees (optional)</span><input value={state.fees} onChange={(e) => onChange({ ...state, fees: e.target.value })} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm" /></label>
        <label><span className="text-muted text-xs">Payment method (optional)</span>
          <select value={state.paymentMethod} onChange={(e) => onChange({ ...state, paymentMethod: e.target.value })} className="input-themed mt-1 h-10 w-full rounded-[var(--radius-input)] px-3 text-sm">
            <option value="">Select</option><option value="Zelle">Zelle</option><option value="PayPal">PayPal</option><option value="Wire">Wire</option><option value="Cash">Cash</option>
          </select>
        </label>
        <label className="sm:col-span-2"><span className="text-muted text-xs">Notes (optional)</span><textarea value={state.notes} onChange={(e) => onChange({ ...state, notes: e.target.value })} className="input-themed mt-1 min-h-20 w-full rounded-[var(--radius-input)] px-3 py-2 text-sm" /></label>
      </div>
      <button type="button" onClick={onSubmit} disabled={submitting} className="btn-accent mt-3 rounded-[var(--radius-input)] px-4 py-2 text-sm font-semibold disabled:opacity-55">{submitting ? "Saving..." : "Save Private Sale"}</button>
    </div>
  );
}
