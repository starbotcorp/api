import type { FastifyRequest } from 'fastify';

/**
 * Simple cache for IP to timezone lookups to avoid repeated API calls
 */
const timezoneCache = new Map<string, { timezone: string; expiresAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Extract timezone from client headers (if provided by frontend)
 */
function getClientTimezone(request: FastifyRequest): string | null {
  // Check for custom timezone header from frontend
  const timezoneHeader = request.headers['x-client-timezone'];
  if (timezoneHeader && typeof timezoneHeader === 'string') {
    return timezoneHeader;
  }

  // Check for standard Time-Zone header sent by modern browsers
  const browserTimezone = request.headers['time-zone'];
  if (browserTimezone && typeof browserTimezone === 'string') {
    return browserTimezone;
  }

  return null;
}

/**
 * Lookup timezone from IP address using ip-api.com (free, no API key required)
 */
async function lookupTimezoneByIP(ip: string): Promise<string | null> {
  // Check cache first
  const cached = timezoneCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.timezone;
  }

  try {
    // Use ip-api.com free endpoint (rate limited but no auth required)
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=timezone`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { timezone?: string };
    if (data.timezone) {
      // Cache the result
      timezoneCache.set(ip, {
        timezone: data.timezone,
        expiresAt: Date.now() + CACHE_TTL,
      });
      return data.timezone;
    }
  } catch (error) {
    // Silently fail - timezone lookup is nice to have, not required
  }

  return null;
}

/**
 * Get the user's timezone for temporal context.
 *
 * Priority:
 * 1. X-Client-Timezone header (from frontend)
 * 2. Time-Zone header (standard browser header)
 * 3. IP-based lookup (via ip-api.com)
 * 4. UTC as fallback
 */
export async function getUserTimezone(request: FastifyRequest, clientIP?: string): Promise<string> {
  // First check client-provided timezone
  const clientTimezone = getClientTimezone(request);
  if (clientTimezone) {
    return clientTimezone;
  }

  // Fall back to IP-based lookup if IP is provided
  if (clientIP) {
    const ipTimezone = await lookupTimezoneByIP(clientIP);
    if (ipTimezone) {
      return ipTimezone;
    }
  }

  // Default to UTC
  return 'UTC';
}

/**
 * Get formatted time in user's timezone
 */
export function formatTimeInTimezone(date: Date, timezone: string): string {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

/**
 * Get current time in user's timezone
 */
export function getCurrentTimeInTimezone(timezone: string): string {
  return formatTimeInTimezone(new Date(), timezone);
}
