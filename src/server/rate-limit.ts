import type { Request, Response, NextFunction } from 'express';

interface RateBucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 10_000;
const buckets = new Map<string, RateBucket>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function evictOldest(): void {
  // Map iterates in insertion order — first key is oldest
  const firstKey = buckets.keys().next().value;
  if (firstKey !== undefined) buckets.delete(firstKey);
}

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      // Evict oldest if at capacity
      if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
        evictOldest();
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - bucket.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > maxRequests) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Too many requests. Please slow down.' },
        id: null,
      });
      return;
    }

    next();
  };
}
