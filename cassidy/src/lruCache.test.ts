// ---------------------------------------------------------------------------
// Tests — LRU Cache with TTL
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LruCache } from './lruCache';

describe('LruCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values', () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set('k1', 'v1');
    expect(cache.get('k1')).toBe('v1');
  });

  it('returns undefined for missing keys', () => {
    const cache = new LruCache<string>(10, 60_000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts expired entries', () => {
    vi.useFakeTimers();
    const cache = new LruCache<string>(10, 100);
    cache.set('k1', 'v1');
    expect(cache.get('k1')).toBe('v1');

    vi.advanceTimersByTime(150);
    expect(cache.get('k1')).toBeUndefined();
  });

  it('evicts LRU entry when maxSize exceeded', () => {
    const cache = new LruCache<string>(2, 60_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3'); // should evict 'a'

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('moves accessed entry to most-recently-used', () => {
    const cache = new LruCache<string>(2, 60_000);
    cache.set('a', '1');
    cache.set('b', '2');

    // Access 'a' so 'b' becomes LRU
    cache.get('a');

    cache.set('c', '3'); // should evict 'b' (LRU)
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });

  it('has() returns true for existing non-expired keys', () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set('k1', 'v1');
    expect(cache.has('k1')).toBe(true);
    expect(cache.has('missing')).toBe(false);
  });

  it('has() returns false for expired keys', () => {
    vi.useFakeTimers();
    const cache = new LruCache<string>(10, 100);
    cache.set('k1', 'v1');
    vi.advanceTimersByTime(150);
    expect(cache.has('k1')).toBe(false);
  });

  it('delete() removes a key', () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set('k1', 'v1');
    expect(cache.delete('k1')).toBe(true);
    expect(cache.get('k1')).toBeUndefined();
  });

  it('clear() empties the cache', () => {
    const cache = new LruCache<string>(10, 60_000);
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('prune() removes expired entries', () => {
    vi.useFakeTimers();
    const cache = new LruCache<string>(10, 100);
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');

    vi.advanceTimersByTime(50);
    cache.set('k3', 'v3'); // added later, not yet expired

    vi.advanceTimersByTime(60); // now k1 and k2 are expired but k3 is not
    const removed = cache.prune();
    expect(removed).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.get('k3')).toBe('v3');
  });

  it('respects custom TTL per set()', () => {
    vi.useFakeTimers();
    const cache = new LruCache<string>(10, 60_000);
    cache.set('short', 'val', 50);
    cache.set('long', 'val', 200);

    vi.advanceTimersByTime(100);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('val');
  });

  it('size reflects current entry count', () => {
    const cache = new LruCache<string>(10, 60_000);
    expect(cache.size).toBe(0);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.size).toBe(2);
  });

  it('overwrites existing key and resets TTL', () => {
    vi.useFakeTimers();
    const cache = new LruCache<string>(10, 100);
    cache.set('k1', 'old');
    vi.advanceTimersByTime(80);
    cache.set('k1', 'new'); // reset TTL
    vi.advanceTimersByTime(50);
    expect(cache.get('k1')).toBe('new'); // should still exist
  });
});
