export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly retryable: boolean,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  accept: "application/json",
  "user-agent": "will-did/1.0 (+https://willdid.net)",
};

/** Seconds or an HTTP date, per RFC 9110; null if absent or unparseable. */
function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

export async function getJSON<T>(
  url: string,
  { retries = 6, timeoutMs = 20_000, onRateLimited }: { retries?: number; timeoutMs?: number; onRateLimited?: () => void } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let wait: number | null = null;
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        wait = retryAfterMs(res.headers.get("retry-after"));
        onRateLimited?.();
      }
      if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, url, true);
      if (!res.ok) throw new HttpError(res.status, url, false);
      return (await res.json()) as T;
    } catch (err) {
      const retryable = err instanceof HttpError ? err.retryable : true;
      if (!retryable || attempt >= retries) throw err;
      // Never shorter than our own backoff: a short Retry-After can otherwise
      // spend every retry within seconds of a rate limit.
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      await sleep(Math.max(wait ?? 0, backoff) + Math.random() * 500);
    }
  }
}

/**
 * Paces requests to one host, finding its tolerable rate as it goes. Calls are
 * spaced at least `gap` apart across every caller sharing the pacer. A 429
 * doubles the gap (up to `maxMs`); each success eases it back 5% toward
 * `minMs`. So it runs fast on a quiet IP and slows itself on a busy one, like a
 * GitHub runner shared with other jobs hitting the same API.
 */
export function pacer(minMs: number, maxMs = 5_000) {
  let gap = minMs;
  let next = 0;
  const stats = { requests: 0, rateLimited: 0, maxGap: minMs };
  return {
    stats,
    gap: () => Math.round(gap),
    /** Fetch JSON through the pacer. */
    async get<T>(url: string): Promise<T> {
      const now = Date.now();
      const at = Math.max(now, next);
      next = at + gap;
      if (at > now) await sleep(at - now);
      stats.requests++;
      const out = await getJSON<T>(url, {
        onRateLimited: () => {
          stats.rateLimited++;
          gap = Math.min(maxMs, gap * 2);
          stats.maxGap = Math.max(stats.maxGap, gap);
        },
      });
      gap = Math.max(minMs, gap * 0.95);
      return out;
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight. Preserves order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (; ;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Postgres-style "2025-11-05 02:55:44+00" and plain ISO both come through here. */
export function toISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const fixed = s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const t = Date.parse(fixed);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
