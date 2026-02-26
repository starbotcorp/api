// TTL-based cache for automatic expiration
// Fix #6: Memory Leak in Device Auth

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private defaultTTL: number = 15 * 60 * 1000, // 15 minutes default
    private cleanupMs: number = 60 * 1000 // Cleanup every minute
  ) {
    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupMs);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  set(key: K, value: V, ttl?: number): void {
    const expiresAt = Date.now() + (ttl ?? this.defaultTTL);
    this.cache.set(key, { value, expiresAt });
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  entries(): IterableIterator<[K, V]> {
    const now = Date.now();
    const validEntries: Array<[K, V]> = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt > now) {
        validEntries.push([key, entry.value]);
      }
    }

    return validEntries[Symbol.iterator]();
  }

  values(): IterableIterator<V> {
    const now = Date.now();
    const validValues: V[] = [];

    for (const entry of this.cache.values()) {
      if (entry.expiresAt > now) {
        validValues.push(entry.value);
      }
    }

    return validValues[Symbol.iterator]();
  }

  keys(): IterableIterator<K> {
    const now = Date.now();
    const validKeys: K[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt > now) {
        validKeys.push(key);
      }
    }

    return validKeys[Symbol.iterator]();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }
}
