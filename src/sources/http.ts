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
  { retries = 6, timeoutMs = 20_000 } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let wait: number | null = null;
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) wait = retryAfterMs(res.headers.get("retry-after"));
      if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, url, true);
      if (!res.ok) throw new HttpError(res.status, url, false);
      return (await res.json()) as T;
    } catch (err) {
      const retryable = err instanceof HttpError ? err.retryable : true;
      if (!retryable || attempt >= retries) throw err;
      await sleep(wait ?? Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500);
    }
  }
}

/** Space calls at least `gapMs` apart, across every caller sharing the gate. */
export function throttle(gapMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
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
