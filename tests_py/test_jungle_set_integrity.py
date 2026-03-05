import json
import os
from pathlib import Path
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
            "(or NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY) to run Jungle tests."
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


def test_jungle_has_exactly_64_distinct_card_numbers():
    rows = _rest_get(
        "card_printings",
        {
            "select": "card_number",
            "set_name": "ilike.jungle",
            "language": "eq.EN",
            "card_number": "in.(" + ",".join(str(i) for i in range(1, 65)) + ")",
            "limit": "5000",
        },
    )
    distinct_numbers = {str(r.get("card_number", "")).strip() for r in rows if str(r.get("card_number", "")).isdigit()}
    assert len(distinct_numbers) == 64, f"Expected 64 unique Jungle card numbers, got {len(distinct_numbers)}"


def test_jungle_card_numbers_are_in_1_to_64_range():
    rows = _rest_get(
        "card_printings",
        {
            "select": "card_number",
            "set_name": "ilike.jungle",
            "language": "eq.EN",
            "limit": "5000",
        },
    )
    values = [int(str(r.get("card_number")).strip()) for r in rows if str(r.get("card_number", "")).strip().isdigit()]
    assert values, "No numeric Jungle card numbers found"
    min_n = min(values)
    max_n = max(values)
    out_of_range = len([n for n in values if n < 1 or n > 64])
    assert min_n == 1, f"Expected Jungle min card number 1, got {min_n}"
    assert max_n == 64, f"Expected Jungle max card number 64, got {max_n}"
    assert out_of_range == 0, f"Found {out_of_range} Jungle rows outside 1..64"


def test_jungle_has_16_holo_and_16_non_holo_in_1_to_32_window():
    rows = _rest_get(
        "card_printings",
        {
            "select": "card_number,finish",
            "set_name": "ilike.jungle",
            "language": "eq.EN",
            "edition": "eq.UNLIMITED",
            "card_number": "in.(" + ",".join(str(i) for i in range(1, 33)) + ")",
            "limit": "5000",
        },
    )
    holo_numbers = {
        int(str(r.get("card_number")).strip())
        for r in rows
        if str(r.get("finish", "")).strip() == "HOLO" and str(r.get("card_number", "")).strip().isdigit()
    }
    non_holo_numbers = {
        int(str(r.get("card_number")).strip())
        for r in rows
        if str(r.get("finish", "")).strip() == "NON_HOLO" and str(r.get("card_number", "")).strip().isdigit()
    }
    holo_count = len(holo_numbers)
    non_holo_count = len(non_holo_numbers)
    assert holo_count == 16, f"Expected 16 holo numbers in Jungle 1..32, got {holo_count}"
    assert non_holo_count == 16, f"Expected 16 non-holo numbers in Jungle 1..32, got {non_holo_count}"


def test_jungle_set_summary_pipeline_has_finish_and_snapshot_rows():
    """
    Pipeline existence check for the Jungle template set.

    Skips when Jungle has no set-summary data yet (backfill not run, or no price
    history for Jungle). Run `npm run sets:backfill-summaries` and ensure Jungle
    has variant/price data for rows to appear.
    """
    finish_rows = _rest_get(
        "public_set_finish_summary",
        {
            "select": "set_id,set_name,finish,market_cap,card_count,updated_at",
            "set_name": "ilike.jungle",
            "limit": "50",
        },
    )
    if not finish_rows:
        pytest.skip(
            "No Jungle rows in public_set_finish_summary. "
            "Run `npm run sets:backfill-summaries` and ensure Jungle has price history (JustTCG ingest + match)."
        )
    assert all(str(r.get("finish", "")).strip() for r in finish_rows), "Expected finish to be present on all finish rows"

    snapshot_rows = _rest_get(
        "public_set_summaries",
        {
            "select": "set_id,set_name,as_of_date,market_cap,heat_score,updated_at",
            "set_name": "ilike.jungle",
            "order": "as_of_date.desc",
            "limit": "5",
        },
    )
    if not snapshot_rows:
        pytest.skip(
            "No Jungle rows in public_set_summaries. "
            "Run `npm run sets:backfill-summaries` and ensure Jungle has price history."
        )
    assert any(str(r.get("set_id", "")).strip() == "jungle" for r in snapshot_rows), "Expected at least one Jungle snapshot with set_id='jungle'"


def test_jungle_set_summary_metrics_are_sane():
    """
    Numerical sanity checks for the Jungle template set.

    Skips when Jungle has no set-summary snapshots yet. When data exists, asserts
    non-negative metrics and reasonable percentage bounds.
    """
    rows = _rest_get(
        "public_set_summaries",
        {
            "select": "set_id,as_of_date,market_cap,market_cap_all_variants,change_7d_pct,change_30d_pct,heat_score,breakout_count,value_zone_count,trend_bullish_count,vote_count",
            "set_id": "eq.jungle",
            "order": "as_of_date.desc",
            "limit": "10",
        },
    )
    if not rows:
        pytest.skip(
            "No Jungle rows in public_set_summaries for set_id='jungle'. "
            "Run `npm run sets:backfill-summaries` and ensure Jungle has price history."
        )

    for row in rows:
        market_cap = row.get("market_cap")
        market_cap_all = row.get("market_cap_all_variants")
        heat_score = row.get("heat_score")

        assert market_cap is None or float(market_cap) >= 0, "market_cap should be non-negative when present"
        assert market_cap_all is None or float(market_cap_all) >= 0, "market_cap_all_variants should be non-negative when present"
        assert heat_score is None or float(heat_score) >= 0, "heat_score should be non-negative when present"

        for key in ("breakout_count", "value_zone_count", "trend_bullish_count", "vote_count"):
            value = row.get(key)
            assert value is None or int(value) >= 0, f"{key} should be non-negative when present"

        for key in ("change_7d_pct", "change_30d_pct"):
            value = row.get(key)
            if value is None:
                continue
            pct = float(value)
            assert -100.0 <= pct <= 1000.0, f"{key} looks unreasonable: {pct}"
