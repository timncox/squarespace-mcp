import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { geocodeAddress } from '../geocoding.js';

describe('geocodeAddress', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return lat/lng for a valid address', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '40.7207559', lon: '-74.0007613' }],
    });

    const result = await geocodeAddress('80 Spring St, New York, NY');

    expect(result.lat).toBeCloseTo(40.7207559);
    expect(result.lng).toBeCloseTo(-74.0007613);

    // Verify User-Agent header
    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].headers['User-Agent']).toBe('SquarespaceHelper/1.0');
  });

  it('should throw when no results found', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await expect(geocodeAddress('xyznonexistent123'))
      .rejects.toThrow('No geocoding results found for address: "xyznonexistent123"');
  });

  it('should throw on HTTP error', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    await expect(geocodeAddress('123 Main St'))
      .rejects.toThrow('Geocoding request failed: 503 Service Unavailable');
  });

  it('should throw on network error', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));

    await expect(geocodeAddress('123 Main St'))
      .rejects.toThrow('Network error');
  });

  it('should URL-encode the address', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '51.5074', lon: '-0.1278' }],
    });

    await geocodeAddress('10 Downing Street, London, UK');

    const url = (global.fetch as any).mock.calls[0][0];
    expect(url).toContain('10%20Downing%20Street');
  });
});
