"""Deterministic synthetic columns for the 3.0 collection (ported from milvus_es_lab).

sha256-seeded so reloads are byte-identical. Stores share a city on purpose so a radius
filter returns a coherent set. first_seen is anchored to `now` (load time): 20% of rows
land inside the last 30 days, the rest spread across the trailing two years.
"""
import datetime as dt
import hashlib

# (name, lon, lat). WKT axis order is lon then lat.
CITIES = [
    ("London", -0.1276, 51.5072), ("Paris", 2.3522, 48.8566),
    ("Amsterdam", 4.9041, 52.3676), ("Brussels", 4.3517, 50.8503),
    ("Dublin", -6.2603, 53.3498), ("Manchester", -2.2426, 53.4808),
    ("Berlin", 13.4050, 52.5200), ("Madrid", -3.7038, 40.4168),
    ("Rome", 12.4964, 41.9028), ("Lisbon", -9.1393, 38.7223),
    ("Warsaw", 21.0122, 52.2297), ("Stockholm", 18.0686, 59.3293),
    ("New York", -74.0060, 40.7128), ("Newark", -74.1724, 40.7357),
    ("Boston", -71.0589, 42.3601), ("Chicago", -87.6298, 41.8781),
    ("Austin", -97.7431, 30.2672), ("Seattle", -122.3321, 47.6062),
    ("San Jose", -121.8863, 37.3382), ("Los Angeles", -118.2437, 34.0522),
    ("Toronto", -79.3832, 43.6532), ("Vancouver", -123.1207, 49.2827),
    ("Mexico City", -99.1332, 19.4326), ("Sao Paulo", -46.6333, -23.5505),
    ("Shenzhen", 114.0579, 22.5431), ("Guangzhou", 113.2644, 23.1291),
    ("Shanghai", 121.4737, 31.2304), ("Hong Kong", 114.1694, 22.3193),
    ("Taipei", 121.5654, 25.0330), ("Seoul", 126.9780, 37.5665),
    ("Tokyo", 139.6917, 35.6895), ("Osaka", 135.5023, 34.6937),
    ("Singapore", 103.8198, 1.3521), ("Bangkok", 100.5018, 13.7563),
    ("Mumbai", 72.8777, 19.0760), ("Bengaluru", 77.5946, 12.9716),
    ("Dubai", 55.2708, 25.2048), ("Tel Aviv", 34.7818, 32.0853),
    ("Sydney", 151.2093, -33.8688), ("Auckland", 174.7633, -36.8485),
]

WINDOW_DAYS = 730
RECENT_DAYS = 30
RECENT_PERCENT = 20


def _seed(value) -> int:
    return int(hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16], 16)


def _city(store):
    return CITIES[_seed(store or "unknown") % len(CITIES)]


def store_city(store) -> str:
    return _city(store)[0]


def store_location_wkt(store) -> str:
    _, lon, lat = _city(store)
    return f"POINT ({lon} {lat})"


def first_seen(parent_asin, now=None) -> str:
    now = now or dt.datetime.now(dt.timezone.utc)
    s = _seed(parent_asin)
    if s % 100 < RECENT_PERCENT:
        days = s % RECENT_DAYS
    else:
        days = RECENT_DAYS + (s % (WINDOW_DAYS - RECENT_DAYS))
    return (now - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_synonyms(path) -> list:
    rules = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                rules.append(line)
    return rules
