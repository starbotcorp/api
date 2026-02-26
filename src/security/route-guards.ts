import crypto from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

function getHeaderValue(header: string | string[] | undefined): string {
  if (Array.isArray(header)) {
    return header[0] ?? '';
  }
  return String(header ?? '');
}

function extractBearerToken(authorizationHeader: string): string {
  if (!authorizationHeader) return '';
  const parts = authorizationHeader.split(' ');
  if (parts.length !== 2) return '';
  const [scheme, token] = parts;
  if (!/^Bearer$/i.test(scheme)) return '';
  return token.trim();
}

function stableTokenHash(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex').slice(0, 16);
}

function cleanupExpiredBuckets(now: number) {
  if (rateBuckets.size < 5000) return;
  for (const [key, value] of rateBuckets.entries()) {
    if (value.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}

export function extractAuthToken(request: FastifyRequest): string {
  const xApiToken = getHeaderValue(request.headers['x-api-token']).trim();
  if (xApiToken) return xApiToken;

  const authHeader = getHeaderValue(request.headers.authorization);
  return extractBearerToken(authHeader);
}

export function requireAuthIfEnabled(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!env.AUTH_ENFORCEMENT_ENABLED) return true;

  const token = extractAuthToken(request);
  if (token) return true;

  reply.code(401).send({
    error: 'unauthorized',
    message: 'Missing API token',
  });
  return false;
}

// Fix #5: Get real client IP considering trusted proxies
const TRUSTED_PROXY_RANGES = [
  // Private IP ranges (RFC 1918)
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  // Localhost
  /^127\./,
  /^::1$/,
];

function isTrustedProxy(ip: string): boolean {
  return TRUSTED_PROXY_RANGES.some(range => range.test(ip));
}

function getRealClientIP(request: FastifyRequest): string {
  // If request is from a trusted proxy, check X-Forwarded-For
  const clientIP = request.ip;

  if (isTrustedProxy(clientIP)) {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded && typeof forwarded === 'string') {
      // X-Forwarded-For format: client, proxy1, proxy2, ...
      // The rightmost untrusted IP is the real client
      const ips = forwarded.split(',').map(ip => ip.trim());

      // Walk from right to left, find first non-trusted IP
      for (let i = ips.length - 1; i >= 0; i--) {
        const ip = ips[i];
        if (ip && !isTrustedProxy(ip)) {
          return ip;
        }
      }

      // All IPs are trusted, use the leftmost
      return ips[0] || clientIP;
    }

    // Also check X-Real-IP header (used by nginx)
    const realIP = request.headers['x-real-ip'];
    if (realIP && typeof realIP === 'string') {
      return realIP;
    }
  }

  return clientIP;
}

interface RateLimitOptions {
  routeKey: string;
  maxRequests: number;
}

export function enforceRateLimitIfEnabled(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RateLimitOptions,
): boolean {
  if (!env.RATE_LIMITING_ENABLED) return true;

  const now = Date.now();
  cleanupExpiredBuckets(now);

  const token = extractAuthToken(request);

  // Fix #5: Use real client IP instead of request.ip
  const clientKey = token
    ? `token:${stableTokenHash(token)}`
    : `ip:${getRealClientIP(request)}`;
  const bucketKey = `${options.routeKey}:${clientKey}`;

  const current = rateBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + env.RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }

  if (current.count >= options.maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    reply.header('Retry-After', String(retryAfterSeconds));
    reply.code(429).send({
      error: 'rate_limited',
      message: 'Too many requests. Please try again later.',
      retry_after_seconds: retryAfterSeconds,
    });
    return false;
  }

  current.count += 1;
  rateBuckets.set(bucketKey, current);
  return true;
}

// Export for testing
export { getRealClientIP, isTrustedProxy };
