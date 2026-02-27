type PerfMeta = Record<string, string | number | boolean | null | undefined>;

const SLOW_THRESHOLD_MS = 500;

function shouldLog(durationMs: number): boolean {
  return durationMs >= SLOW_THRESHOLD_MS;
}

export async function measureAsync<T>(name: string, meta: PerfMeta, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const durationMs = Math.round(performance.now() - start);
    if (shouldLog(durationMs)) {
      console.info("[perf]", JSON.stringify({ name, durationMs, ...meta }));
    }
  }
}

