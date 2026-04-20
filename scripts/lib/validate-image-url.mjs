// HEAD-probes image URLs before they get written to card_printings /
// canonical_cards. Wraps a small concurrent pool plus a per-run cache so the
// same URL is never probed twice within a single ingest invocation.
//
// Why: pokemontcg.io doesn't host images for many promo / McDonald's sets.
// Writing those dead URLs caused the UI to render a "No image" placeholder
// that users read as "the back of the card." See ingestion-pipeline-playbook
// "URL validation".

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 10;

async function probeUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function createImageUrlValidator({
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  let probed = 0;

  async function validate(url) {
    if (typeof url !== "string" || url.length === 0) {
      return { ok: false, status: 0, error: "no-url" };
    }
    let pending = cache.get(url);
    if (!pending) {
      probed += 1;
      pending = probeUrl(url, timeoutMs);
      cache.set(url, pending);
    }
    return pending;
  }

  async function validateAll(urls) {
    const unique = [
      ...new Set(urls.filter((url) => typeof url === "string" && url.length > 0)),
    ];
    const needed = unique.filter((url) => !cache.has(url));
    let index = 0;
    async function worker() {
      while (true) {
        const i = index++;
        if (i >= needed.length) return;
        await validate(needed[i]);
      }
    }
    const workerCount = Math.max(1, Math.min(concurrency, needed.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const results = new Map();
    for (const url of unique) {
      results.set(url, await cache.get(url));
    }
    return results;
  }

  function stats() {
    return { probed, cached: cache.size };
  }

  return { validate, validateAll, stats };
}

export function formatProbeError(url, probe) {
  if (!probe) return `HEAD ${url} → no result`.slice(0, 500);
  const suffix = probe.status > 0 ? `HTTP ${probe.status}` : probe.error ?? "network error";
  return `HEAD ${url} → ${suffix}`.slice(0, 500);
}
