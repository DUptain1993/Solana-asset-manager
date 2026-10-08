const BUCKETS = new Map();
const CAPACITY = 20;
const REFILL_PER_SEC = 0.5;

export function allow(ip) {
  const now = Date.now();
  const b = BUCKETS.get(ip) || { tokens: CAPACITY, ts: now };
  const elapsed = (now - b.ts) / 1000;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsed * REFILL_PER_SEC);
  b.ts = now;
  if (b.tokens < 1) {
    BUCKETS.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  BUCKETS.set(ip, b);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, b] of BUCKETS) if (b.ts < cutoff) BUCKETS.delete(ip);
}, 60_000).unref?.();
