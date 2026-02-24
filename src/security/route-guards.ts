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
  const clientKey = token
    ? `token:${stableTokenHash(token)}`
    : `ip:${request.ip || 'unknown'}`;
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
