# Pricing Pipeline Debug

All cron and debug endpoints now prefer `Authorization: Bearer <CRON_SECRET>`.
`?secret=` is a temporary deprecated fallback for manual browser checks.

Verification SQL:

```sql
select count(*) from variant_metrics;
```

```sql
select count(*) from variant_metrics where signals_as_of_ts is not null;
```

```sql
select canonical_slug, variant_ref, provider, grade, history_points_30d, signal_trend, signal_breakout, signal_value
from variant_metrics
where canonical_slug = 'base-4-charizard'
order by history_points_30d desc, updated_at desc;
```

```sql
select variant_ref, count(*) as points_30d, max(ts) as latest_ts
from price_history_points
where canonical_slug = 'base-4-charizard'
  and ts >= now() - interval '30 days'
group by variant_ref
order by count(*) desc, max(ts) desc;
```
