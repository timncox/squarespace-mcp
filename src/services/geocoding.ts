/**
 * Geocoding utility — converts street addresses to lat/lng coordinates.
 * Uses Nominatim (OpenStreetMap) free API.
 */

export interface GeocodingResult {
  lat: number;
  lng: number;
}

export async function geocodeAddress(address: string): Promise<GeocodingResult> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'SquarespaceHelper/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Geocoding request failed: ${response.status} ${response.statusText}`);
  }

  const results = await response.json() as Array<{ lat: string; lon: string }>;

  if (!results || results.length === 0) {
    throw new Error(`No geocoding results found for address: "${address}"`);
  }

  return {
    lat: parseFloat(results[0].lat),
    lng: parseFloat(results[0].lon),
  };
}
