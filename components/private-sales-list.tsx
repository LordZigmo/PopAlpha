export type PrivateSale = {
  id: string;
  cert: string;
  price: number;
  currency: string;
  sold_at: string;
  fees: number | null;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
};

function fmtDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export default function PrivateSalesList({ sales, loading, error, onRefresh, onDelete }: { sales: PrivateSale[]; loading: boolean; error: string | null; onRefresh: () => void; onDelete: (id: string) => void }) {
  return (
    <div className="rounded-[var(--radius-card)] border-app border bg-surface-soft/55 p-[var(--space-card)]">
      <div className="mb-3 flex items-center justify-between"><p className="text-app text-sm font-semibold">Private Sales</p><button type="button" onClick={onRefresh} className="btn-ghost rounded-[var(--radius-input)] px-3 py-1 text-xs">Refresh</button></div>
      {loading ? <p className="text-muted text-sm">Loading private sales…</p> : null}
      {error ? <p className="text-negative text-sm">{error}</p> : null}
      {!loading && !error && sales.length === 0 ? <p className="text-muted text-sm">No private sales yet.</p> : null}
      {!loading && !error && sales.length > 0 ? <ul className="space-y-2">{sales.map((sale) => { const net = Number(sale.price) - Number(sale.fees ?? 0); return <li key={sale.id} className="rounded-[var(--radius-input)] border-app border bg-surface p-3 text-sm"><div className="flex items-center justify-between"><p className="font-semibold tabular-nums">${Number(sale.price).toFixed(2)}</p><button className="btn-ghost rounded-[var(--radius-input)] px-2 py-1 text-xs" onClick={() => onDelete(sale.id)}>Delete</button></div><p className="text-muted">Sold: {fmtDate(sale.sold_at)}</p><p className="text-muted">Fees: {sale.fees === null ? "—" : `$${Number(sale.fees).toFixed(2)}`}</p><p className="text-positive">Net: ${net.toFixed(2)}</p>{sale.payment_method ? <p className="text-muted">Payment: {sale.payment_method}</p> : null}{sale.notes ? <p className="text-muted">Notes: {sale.notes}</p> : null}</li>;})}</ul> : null}
    </div>
  );
}
