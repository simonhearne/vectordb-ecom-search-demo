// Same 40 entries as `scripts/synth.py` (keep the two in sync; the loader is the source of
// truth). Used to resolve `Filters.near.city` into a lon/lat for `st_dwithin`.
export interface City { name: string; lon: number; lat: number }

export const CITIES: City[] = [
  { name: "London", lon: -0.1276, lat: 51.5072 }, { name: "Paris", lon: 2.3522, lat: 48.8566 },
  { name: "Amsterdam", lon: 4.9041, lat: 52.3676 }, { name: "Brussels", lon: 4.3517, lat: 50.8503 },
  { name: "Dublin", lon: -6.2603, lat: 53.3498 }, { name: "Manchester", lon: -2.2426, lat: 53.4808 },
  { name: "Berlin", lon: 13.405, lat: 52.52 }, { name: "Madrid", lon: -3.7038, lat: 40.4168 },
  { name: "Rome", lon: 12.4964, lat: 41.9028 }, { name: "Lisbon", lon: -9.1393, lat: 38.7223 },
  { name: "Warsaw", lon: 21.0122, lat: 52.2297 }, { name: "Stockholm", lon: 18.0686, lat: 59.3293 },
  { name: "New York", lon: -74.006, lat: 40.7128 }, { name: "Newark", lon: -74.1724, lat: 40.7357 },
  { name: "Boston", lon: -71.0589, lat: 42.3601 }, { name: "Chicago", lon: -87.6298, lat: 41.8781 },
  { name: "Austin", lon: -97.7431, lat: 30.2672 }, { name: "Seattle", lon: -122.3321, lat: 47.6062 },
  { name: "San Jose", lon: -121.8863, lat: 37.3382 }, { name: "Los Angeles", lon: -118.2437, lat: 34.0522 },
  { name: "Toronto", lon: -79.3832, lat: 43.6532 }, { name: "Vancouver", lon: -123.1207, lat: 49.2827 },
  { name: "Mexico City", lon: -99.1332, lat: 19.4326 }, { name: "Sao Paulo", lon: -46.6333, lat: -23.5505 },
  { name: "Shenzhen", lon: 114.0579, lat: 22.5431 }, { name: "Guangzhou", lon: 113.2644, lat: 23.1291 },
  { name: "Shanghai", lon: 121.4737, lat: 31.2304 }, { name: "Hong Kong", lon: 114.1694, lat: 22.3193 },
  { name: "Taipei", lon: 121.5654, lat: 25.033 }, { name: "Seoul", lon: 126.978, lat: 37.5665 },
  { name: "Tokyo", lon: 139.6917, lat: 35.6895 }, { name: "Osaka", lon: 135.5023, lat: 34.6937 },
  { name: "Singapore", lon: 103.8198, lat: 1.3521 }, { name: "Bangkok", lon: 100.5018, lat: 13.7563 },
  { name: "Mumbai", lon: 72.8777, lat: 19.076 }, { name: "Bengaluru", lon: 77.5946, lat: 12.9716 },
  { name: "Dubai", lon: 55.2708, lat: 25.2048 }, { name: "Tel Aviv", lon: 34.7818, lat: 32.0853 },
  { name: "Sydney", lon: 151.2093, lat: -33.8688 }, { name: "Auckland", lon: 174.7633, lat: -36.8485 },
];

export const findCity = (name: string): City | undefined =>
  CITIES.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
