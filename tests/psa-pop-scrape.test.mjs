import assert from "node:assert/strict";

import { fetchPopSetItems, normalizePopSetRow } from "../lib/psa/pop-scrape.ts";

// ── normalizePopSetRow ────────────────────────────────────────────────
// Field names per established GetSetItems scrapers.
{
  const row = normalizePopSetRow({
    SpecID: 10041062,
    SubjectName: "MEW ex",
    CardNumber: "347",
    Variety: "SPECIAL ART RARE",
    GradeN0: 1,
    Grade9: 120,
    Grade10: 480,
    Total: 700,
  });
  assert.equal(row.specId, 10041062);
  assert.equal(row.subject, "MEW ex");
  assert.equal(row.cardNumber, "347");
  assert.equal(row.variety, "SPECIAL ART RARE");
  assert.equal(row.total, 700);
  assert.deepEqual(row.gradeCounts, { GradeN0: 1, Grade9: 120, Grade10: 480, Total: 700 });
}

// Aggregate/total rows without a SpecID (PSA's first row) drop out.
assert.equal(normalizePopSetRow({ SubjectName: "TOTAL", Grade10: 99999 }), null);
assert.equal(normalizePopSetRow(null), null);
assert.equal(normalizePopSetRow("row"), null);
assert.equal(normalizePopSetRow({ SpecID: 0, SubjectName: "X" }), null);

// Casing/aliases tolerated; string ids parsed; SpecID never leaks into
// gradeCounts.
{
  const row = normalizePopSetRow({
    specId: "666080",
    subject: "PIKACHU - HOLO",
    cardNumber: "",
    Grade10: 3,
  });
  assert.equal(row.specId, 666080);
  assert.equal(row.subject, "PIKACHU - HOLO");
  assert.equal(row.cardNumber, null);
  assert.equal(row.gradeCounts.specId, undefined);
  assert.deepEqual(row.gradeCounts, { Grade10: 3 });
}

// ── fetchPopSetItems pagination ───────────────────────────────────────
{
  const calls = [];
  const pageOne = Array.from({ length: 30 }, (_, index) => ({
    SpecID: 1000 + index,
    SubjectName: `CARD ${index}`,
    CardNumber: String(index + 1),
    Grade10: index,
  }));
  // Aggregate row + a duplicate of a page-one spec on page two.
  const pageTwo = [
    { SubjectName: "TOTALS", Grade10: 999 },
    { SpecID: 1000, SubjectName: "CARD 0", CardNumber: "1", Grade10: 0 },
    { SpecID: 2000, SubjectName: "LAST CARD", CardNumber: "31", Grade10: 7 },
  ];
  const fetchImpl = async (url, init) => {
    const form = new URLSearchParams(init.body);
    calls.push({
      url,
      method: init.method,
      headingID: form.get("headingID"),
      categoryID: form.get("categoryID"),
      draw: form.get("draw"),
      start: form.get("start"),
      length: form.get("length"),
    });
    const body = calls.length === 1
      ? { data: pageOne, recordsTotal: 33 }
      : { data: pageTwo, recordsTotal: 33 };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };

  const result = await fetchPopSetItems({
    headingId: 189863,
    categoryId: 12345,
    pageSize: 30,
    interPageDelayMs: 1,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://www.psacard.com/Pop/GetSetItems");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(
    [calls[0].headingID, calls[0].categoryID, calls[0].draw, calls[0].start, calls[0].length],
    ["189863", "12345", "1", "0", "30"],
  );
  assert.deepEqual([calls[1].draw, calls[1].start], ["2", "30"]);

  assert.equal(result.recordsTotal, 33);
  assert.equal(result.pagesFetched, 2);
  // 30 + 2 unique specs (aggregate row skipped, duplicate deduped).
  assert.equal(result.rows.length, 31);
  assert.equal(result.skippedRows, 1);
  assert.equal(result.rows.at(-1).specId, 2000);
}

// Non-OK responses surface as errors (the Cloudflare-block signature).
{
  let threw = false;
  try {
    await fetchPopSetItems({
      headingId: 1,
      categoryId: 2,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
  } catch (error) {
    threw = true;
    assert.match(String(error), /HTTP 403/);
  }
  assert.ok(threw);
}

console.log("psa-pop-scrape tests passed");
