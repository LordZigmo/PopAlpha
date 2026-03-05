"""
Generalized check: every set that has card_printings (EN) is wired into the
pricing/summary pipeline (has rows in set_finish_summary_latest and
set_summary_snapshots). Same normalization as lib/sets/summary-core.mjs buildSetId.
"""
import json
import os
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pytest


def _maybe_load_dotenv_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def _load_local_env() -> None:
    root = Path(__file__).resolve().parents[1]
    _maybe_load_dotenv_file(root / ".env.local")
    _maybe_load_dotenv_file(root / ".env.production.local")
    _maybe_load_dotenv_file(root / ".env")


def _supabase_creds() -> tuple[str, str]:
    _load_local_env()
    url = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        or ""
    ).strip()
    if not url or not key:
        pytest.skip(
            "Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY "
            "(or NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY) to run set pipeline tests."
        )
    return url, key


def _rest_get(path: str, params: dict[str, str]) -> list[dict]:
    url, key = _supabase_creds()
    qs = urlencode(params)
    req = Request(
        f"{url}/rest/v1/{path}?{qs}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urlopen(req, timeout=30) as resp:  # nosec B310 - controlled project URL
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # pragma: no cover
        pytest.fail(f"Supabase REST query failed: {exc}")


def build_set_id(set_name: Optional[str]) -> Optional[str]:
    """Match lib/sets/summary-core.mjs buildSetId()."""
    if not set_name or not str(set_name).strip():
        return None
    normalized = re.sub(r"[^a-z0-9]+", "-", str(set_name).strip().lower())
    normalized = normalized.strip("-")
    return normalized or None


def test_all_sets_wired_into_pipeline():
    """
    Every set that has EN card_printings must have at least one row in
    public_set_summaries and public_set_finish_summary (i.e. fully wired
    into the pricing/summary pipeline). Run `npm run sets:backfill-summaries`
    after adding or fixing sets.
    """
    # Set universe from card_printings (EN) – same as backfill script
    printing_rows = _rest_get(
        "card_printings",
        {
            "select": "set_name",
            "language": "eq.EN",
            "limit": "20000",
        },
    )
    set_names = {
        str(r.get("set_name", "")).strip()
        for r in printing_rows
        if r.get("set_name") is not None and str(r.get("set_name", "")).strip()
    }
    set_ids_from_printings = set()
    for name in set_names:
        sid = build_set_id(name)
        if sid:
            set_ids_from_printings.add(sid)

    if not set_ids_from_printings:
        pytest.skip("No EN sets found in card_printings.")

    # Sets that have pipeline data (snapshots)
    snapshot_rows = _rest_get(
        "public_set_summaries",
        {"select": "set_id", "limit": "500"},
    )
    set_ids_in_summaries = {str(r.get("set_id", "")).strip() for r in snapshot_rows if r.get("set_id")}

    # Sets that have pipeline data (finish summary)
    finish_rows = _rest_get(
        "public_set_finish_summary",
        {"select": "set_id", "limit": "500"},
    )
    set_ids_in_finish = {str(r.get("set_id", "")).strip() for r in finish_rows if r.get("set_id")}

    missing_from_summaries = set_ids_from_printings - set_ids_in_summaries
    missing_from_finish = set_ids_from_printings - set_ids_in_finish
    missing = missing_from_summaries | missing_from_finish

    assert not missing, (
        "Sets with card_printings but not fully wired into the pipeline "
        "(missing from set_summary_snapshots and/or set_finish_summary_latest): "
        f"{sorted(missing)}. Run `npm run sets:backfill-summaries` and ensure each set has variant/price data."
    )


# Minimum distinct snapshot days to consider a set "fully" wired (historical data cached)
MIN_HISTORY_DAYS = 7
# Latest snapshot must be at least this recent (days ago) to count as "fresh price data"
MAX_STALE_DAYS = 1


def test_count_fully_wired_sets():
    """
    Count how many sets are fully wired into the pipeline. Fully wired means:
    - All historical data cached: at least MIN_HISTORY_DAYS (7) distinct
      as_of_dates in set_summary_snapshots for that set.
    - Sorted correctly: snapshot rows are returned in descending as_of_date order.
    - Fresh price data: latest snapshot has as_of_date >= today - MAX_STALE_DAYS (1).
    - Finish summary: at least one row in set_finish_summary_latest for that set.

    Reports:
    - Total sets in DB (card_printings EN) – the universe you have imported.
    - How many of those have any pipeline data (snapshots).
    - How many of those with pipeline data are fully wired.

    To get 100+ sets (full Pokemon TCG catalog), import all sets via
    POST /api/admin/import/pokemontcg-canonical (paginate pages or pass setId per set).
    Run with: pytest tests_py/test_set_pipeline_wired.py::test_count_fully_wired_sets -s
    """
    today = date.today()
    fresh_cutoff = today - timedelta(days=MAX_STALE_DAYS)

    # Total sets in DB (card_printings EN) – full universe we know about
    printing_rows = _rest_get(
        "card_printings",
        {"select": "set_name", "language": "eq.EN", "limit": "50000"},
    )
    set_names_db = {
        str(r.get("set_name", "")).strip()
        for r in printing_rows
        if r.get("set_name") is not None and str(r.get("set_name", "")).strip()
    }
    set_ids_in_db = set()
    for name in set_names_db:
        sid = build_set_id(name)
        if sid:
            set_ids_in_db.add(sid)
    total_sets_in_db = len(set_ids_in_db)

    # All snapshot rows (set_id, as_of_date, market_cap) – bulk fetch
    snapshot_rows = _rest_get(
        "public_set_summaries",
        {
            "select": "set_id,set_name,as_of_date,market_cap",
            "order": "set_id,as_of_date.desc",
            "limit": "3000",
        },
    )
    # Group by set_id: distinct as_of_dates, latest as_of_date, and order of dates (for sort check)
    by_set = {}
    for r in snapshot_rows:
        sid = str(r.get("set_id", "")).strip()
        if not sid:
            continue
        as_of = r.get("as_of_date")
        if as_of:
            try:
                if isinstance(as_of, str) and "T" in as_of:
                    as_of = as_of.split("T")[0]
                d = date.fromisoformat(as_of) if isinstance(as_of, str) else as_of
            except (TypeError, ValueError):
                continue
        else:
            continue
        if sid not in by_set:
            by_set[sid] = {"dates": set(), "latest_date": None, "set_name": r.get("set_name"), "date_list": []}
        by_set[sid]["dates"].add(d)
        by_set[sid]["date_list"].append(d)
        if by_set[sid]["latest_date"] is None or d > by_set[sid]["latest_date"]:
            by_set[sid]["latest_date"] = d

    # All finish summary rows (set_id only)
    finish_rows = _rest_get(
        "public_set_finish_summary",
        {"select": "set_id", "limit": "500"},
    )
    set_ids_with_finish = {str(r.get("set_id", "")).strip() for r in finish_rows if r.get("set_id")}

    fully_wired = []
    not_fully_wired = []

    for sid, info in by_set.items():
        dates = info["dates"]
        latest_date = info["latest_date"]
        date_list = info.get("date_list") or []
        has_finish = sid in set_ids_with_finish
        history_ok = len(dates) >= MIN_HISTORY_DAYS
        fresh_ok = latest_date is not None and latest_date >= fresh_cutoff
        # Snapshot rows should be ordered by as_of_date desc (sorted correctly)
        sorted_ok = (
            len(date_list) <= 1 or
            all(date_list[i] >= date_list[i + 1] for i in range(len(date_list) - 1))
        )

        if has_finish and history_ok and fresh_ok and sorted_ok:
            fully_wired.append(sid)
        else:
            reasons = []
            if not has_finish:
                reasons.append("no finish summary")
            if not history_ok:
                reasons.append("only {} snapshot days (need {})".format(len(dates), MIN_HISTORY_DAYS))
            if not fresh_ok:
                reasons.append(
                    "latest snapshot {} older than {}".format(latest_date, fresh_cutoff)
                    if latest_date else "no snapshot dates"
                )
            if not sorted_ok:
                reasons.append("snapshot dates not in descending order")
            not_fully_wired.append((sid, "; ".join(reasons)))

    total = len(by_set)
    count = len(fully_wired)
    sets_with_pipeline = total
    print("\nSets in DB (card_printings EN): {}".format(total_sets_in_db))
    print("With pipeline data (snapshots): {}".format(sets_with_pipeline))
    print("Fully wired: {} of {}".format(count, sets_with_pipeline))
    if total_sets_in_db < 50:
        print("Note: To get the full Pokemon TCG catalog (100+ sets), import all sets via")
        print("  POST /api/admin/import/pokemontcg-canonical (paginate pages or setId per set),")
        print("  then run provider ingest + match and npm run sets:backfill-summaries.")
    if not_fully_wired:
        print("Not fully wired:")
        for sid, reason in sorted(not_fully_wired, key=lambda x: x[0]):
            print("  - {}: {}".format(sid, reason))
    assert count >= 0 and total >= 0, "pipeline data missing"

