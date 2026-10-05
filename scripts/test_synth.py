import datetime as dt
import synth


def test_first_seen_is_deterministic_and_rfc3339():
    now = dt.datetime(2026, 9, 3, tzinfo=dt.timezone.utc)
    a = synth.first_seen("B000001", now)
    b = synth.first_seen("B000001", now)
    assert a == b
    assert a.endswith("Z") and len(a) == 20


def test_first_seen_within_two_years():
    now = dt.datetime(2026, 9, 3, tzinfo=dt.timezone.utc)
    for i in range(500):
        s = synth.first_seen(f"ASIN{i}", now)
        d = dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        assert dt.timedelta(0) <= now - d < dt.timedelta(days=730)


def test_about_twenty_percent_recent():
    now = dt.datetime(2026, 9, 3, tzinfo=dt.timezone.utc)
    recent = 0
    for i in range(2000):
        s = synth.first_seen(f"ASIN{i}", now)
        d = dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        if now - d < dt.timedelta(days=30):
            recent += 1
    assert 0.15 < recent / 2000 < 0.25


def test_store_city_and_location_agree():
    city = synth.store_city("Sony")
    wkt = synth.store_location_wkt("Sony")
    name, lon, lat = next(c for c in synth.CITIES if c[0] == city)
    assert wkt == f"POINT ({lon} {lat})"


def test_read_synonyms_skips_comments(tmp_path):
    p = tmp_path / "syn.txt"
    p.write_text("# c\nipad, tablet\n\nlaptop, notebook\n")
    assert synth.read_synonyms(p) == ["ipad, tablet", "laptop, notebook"]
