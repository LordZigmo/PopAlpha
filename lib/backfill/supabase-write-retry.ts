const DEFAULT_SUPABASE_WRITE_RETRY_ATTEMPTS = process.env.SUPABASE_WRITE_RETRY_ATTEMPTS
  ? Math.max(1, parseInt(process.env.SUPABASE_WRITE_RETRY_ATTEMPTS, 10))
  : 5;
const DEFAULT_SUPABASE_WRITE_RETRY_BACKOFF_MS = process.env.SUPABASE_WRITE_RETRY_BACKOFF_MS
  ? Math.max(0, parseInt(process.env.SUPABASE_WRITE_RETRY_BACKOFF_MS, 10))
  : 400;

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableSupabaseWriteErrorMessage(message: string): boolean {
  const normalized = normalizeText(message).toLowerCase();
  return normalized.includes("fetch failed")
    || normalized.includes("network")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("socket")
    || normalized.includes("econnreset")
    || normalized.includes("etimedout")
    || normalized.includes("eai_again")
    || normalized.includes("statement timeout")
    || normalized.includes("connection")
    || normalized.includes("web server is down")
    || normalized.includes("error code 521")
    || normalized.includes("429")
    || normalized.includes("500")
    || normalized.includes("502")
    || normalized.includes("503")
    || normalized.includes("504");
}

export async function retrySupabaseWriteOperation<T>(
  label: string,
  operation: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseBackoffMs?: number;
    jitterMs?: number;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_SUPABASE_WRITE_RETRY_ATTEMPTS));
  const baseBackoffMs = Math.max(0, Math.floor(opts.baseBackoffMs ?? DEFAULT_SUPABASE_WRITE_RETRY_BACKOFF_MS));
  const jitterMs = Math.max(0, Math.floor(opts.jitterMs ?? 200));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = attempt < maxAttempts && isRetryableSupabaseWriteErrorMessage(message);
      if (!canRetry) {
        throw new Error(`${label}: ${message}`);
      }

      const delayMs = Math.min(5000, baseBackoffMs * 2 ** (attempt - 1))
        + Math.floor(Math.random() * (jitterMs + 1));
      console.warn(`${label} attempt ${attempt} failed: ${message}. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${label}: exhausted retries`);
}
