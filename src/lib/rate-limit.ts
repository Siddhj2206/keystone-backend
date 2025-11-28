import type { Context, Next } from "hono";

interface RateLimitConfig {
  maxRequests: number; // Max requests allowed
  keyGenerator?: (c: Context) => string; // Custom key generator
}

interface RateLimitEntry {
  count: number;
}

// In-memory store
const store = new Map<string, RateLimitEntry>();

/**
 * Creates a rate limiting middleware based on request count only
 */
export function rateLimiter(config: RateLimitConfig) {
  const { maxRequests, keyGenerator } = config;

  return async (c: Context, next: Next) => {
    // Generate key (default: IP address)
    const key = keyGenerator
      ? keyGenerator(c)
      : c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";

    let entry = store.get(key);

    // Create new entry if doesn't exist
    if (!entry) {
      entry = { count: 0 };
    }

    entry.count++;
    store.set(key, entry);

    // Set rate limit headers
    const remaining = Math.max(0, maxRequests - entry.count);
    c.header("X-RateLimit-Limit", maxRequests.toString());
    c.header("X-RateLimit-Remaining", remaining.toString());

    // Check if over limit
    if (entry.count > maxRequests) {
      return c.json(
        {
          error: "Too many requests",
        },
        429
      );
    }

    return next();
  };
}

/**
 * Rate limit for auth endpoints
 * NOTE: Disabled for development - set high limit
 */
export const authRateLimiter = rateLimiter({
  maxRequests: 999999, // Effectively disabled for dev
  keyGenerator: (c) =>
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown",
});

/**
 * Standard rate limit for API endpoints
 */
export const apiRateLimiter = rateLimiter({
  maxRequests: 1000,
});

/**
 * Rate limit for expensive operations (AI parsing)
 */
export const aiRateLimiter = rateLimiter({
  maxRequests: 100,
});
