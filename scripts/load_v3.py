#!/usr/bin/env python3
"""Build amazon_reviews_v3 on the Milvus 3.0 Zilliz Cloud instance from the lab parquet.

  python3 scripts/load_v3.py --schema-only          # print the schema, touch nothing
  python3 scripts/load_v3.py                        # create + load (refuses if it exists)
  python3 scripts/load_v3.py --drop                 # drop + recreate + load
  python3 scripts/load_v3.py --reanchor             # re-upsert first_seen only (before a demo)
  python3 scripts/load_v3.py --limit 2000           # small validation run

Parquet default: ~/Projects/milvus_es_lab/data/amazon_reviews.parquet (fetch it there with
`python data/fetch.py`). Reads ZILLIZ_ENDPOINT + ZILLIZ_WRITE_TOKEN (fallback ZILLIZ_TOKEN)
from env, else .dev.vars. Run with the repo venv: .venv/bin/python scripts/load_v3.py
"""
import argparse
import os
import re
import sys
import time

import pyarrow.parquet as pq
from pymilvus import DataType, Function, FunctionType, MilvusClient

import synth

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
COLLECTION = "amazon_reviews_v3"
DEFAULT_PARQUET = os.path.expanduser("~/Projects/milvus_es_lab/data/amazon_reviews.parquet")
BATCH = 500

EN_FILTERS = [
    "lowercase",
    "asciifolding",
    {"type": "stemmer", "language": "english"},
    {"type": "stop", "stop_words": ["_english_"]},
]
EN_ANALYZER = {"tokenizer": "standard", "filter": EN_FILTERS}


def syn_analyzer(rules):
    filt = list(EN_FILTERS)
    stem_idx = next(i for i, f in enumerate(filt) if isinstance(f, dict) and f.get("type") == "stemmer")
    filt.insert(stem_idx, {"type": "synonym", "synonyms": rules, "expand": True})
    return {"tokenizer": "standard", "filter": filt}


def load_env():
    env = {k: v for k, v in os.environ.items() if k.startswith("ZILLIZ_")}
    dv = os.path.join(ROOT, ".dev.vars")
    if os.path.exists(dv):
        for line in open(dv, encoding="utf-8"):
            m = re.match(r"^\s*([A-Z_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) not in env:
                env[m.group(1)] = m.group(2).strip("\"'")
    ep = env.get("ZILLIZ_ENDPOINT")
    tok = env.get("ZILLIZ_WRITE_TOKEN") or env.get("ZILLIZ_TOKEN")
    if not ep or not tok:
        sys.exit("Missing ZILLIZ_ENDPOINT / ZILLIZ_WRITE_TOKEN (env or .dev.vars)")
    if not env.get("ZILLIZ_WRITE_TOKEN"):
        print("warning: ZILLIZ_WRITE_TOKEN not set; using ZILLIZ_TOKEN (probably read-only)")
    return ep, tok


def build_schema(client, rules):
    s = client.create_schema(auto_id=False, enable_dynamic_field=False)
    s.add_field("parent_asin", DataType.VARCHAR, is_primary=True, max_length=24)
    s.add_field("title", DataType.VARCHAR, max_length=4096)
    s.add_field("text_snippet", DataType.VARCHAR, max_length=8192,
                enable_analyzer=True, enable_match=True, analyzer_params=EN_ANALYZER)
    s.add_field("text_syn", DataType.VARCHAR, max_length=8192,
                enable_analyzer=True, analyzer_params=syn_analyzer(rules))
    s.add_field("store", DataType.VARCHAR, max_length=512)
    s.add_field("main_category", DataType.VARCHAR, max_length=128)
    s.add_field("image_url", DataType.VARCHAR, max_length=1024)
    s.add_field("categories", DataType.ARRAY, element_type=DataType.VARCHAR,
                max_capacity=16, max_length=128)
    s.add_field("price", DataType.DOUBLE)
    s.add_field("average_rating", DataType.DOUBLE)
    s.add_field("rating_number", DataType.INT64)
    s.add_field("first_seen", DataType.TIMESTAMPTZ)
    s.add_field("store_city", DataType.VARCHAR, max_length=64)
    s.add_field("store_location", DataType.GEOMETRY)
    s.add_field("text_vec", DataType.FLOAT_VECTOR, dim=1024)
    s.add_field("image_vec", DataType.FLOAT_VECTOR, dim=1024)
    s.add_field("text_sparse", DataType.SPARSE_FLOAT_VECTOR)
    s.add_field("text_syn_sparse", DataType.SPARSE_FLOAT_VECTOR)
    s.add_function(Function(name="text_snippet_bm25", function_type=FunctionType.BM25,
                            input_field_names=["text_snippet"], output_field_names=["text_sparse"]))
    s.add_function(Function(name="text_syn_bm25", function_type=FunctionType.BM25,
                            input_field_names=["text_syn"], output_field_names=["text_syn_sparse"]))
    return s


def create_indexes(client):
    """Vector indexes try IVF_RABITQ first; Zilliz Cloud may only accept AUTOINDEX."""
    def add_vec(idx, field, index_type):
        if index_type == "IVF_RABITQ":
            idx.add_index(field_name=field, index_type="IVF_RABITQ", metric_type="COSINE",
                          params={"nlist": 1024, "refine": True, "refine_type": "SQ8"})
        else:
            idx.add_index(field_name=field, index_type="AUTOINDEX", metric_type="COSINE")

    for vec_type in ("IVF_RABITQ", "AUTOINDEX"):
        try:
            idx = client.prepare_index_params()
            add_vec(idx, "text_vec", vec_type)
            add_vec(idx, "image_vec", vec_type)
            client.create_index(COLLECTION, idx)
            print(f"vector indexes: {vec_type}")
            break
        except Exception as e:  # noqa: BLE001
            print(f"{vec_type} rejected ({e}); falling back")
    else:
        sys.exit("could not create vector indexes")

    idx = client.prepare_index_params()
    for f in ("text_sparse", "text_syn_sparse"):
        idx.add_index(field_name=f, index_type="AUTOINDEX", metric_type="BM25")
    for f in ("main_category", "store", "price", "average_rating", "rating_number"):
        idx.add_index(field_name=f, index_type="INVERTED")
    idx.add_index(field_name="store_location", index_type="RTREE")
    client.create_index(COLLECTION, idx)


def rows_from(table, start, stop):
    cols = {c: table.column(c)[start:stop].to_pylist() for c in table.column_names}
    n = stop - start
    out = []
    for i in range(n):
        asin = cols["parent_asin"][i]
        store = cols["store"][i]
        out.append({
            "parent_asin": asin,
            "title": cols["title"][i],
            "text_snippet": cols["text_snippet"][i],
            "text_syn": cols["text_snippet"][i],
            "store": store,
            "main_category": cols["main_category"][i],
            "image_url": cols["image_url"][i],
            "categories": cols["categories"][i] or [],
            "price": float(cols["price"][i]),
            "average_rating": float(cols["average_rating"][i]),
            "rating_number": int(cols["rating_number"][i]),
            "first_seen": synth.first_seen(asin),
            "store_city": synth.store_city(store),
            "store_location": synth.store_location_wkt(store),
            "text_vec": cols["text_vec"][i],
            "image_vec": cols["image_vec"][i],
        })
    return out


def wait_compaction(client):
    try:
        job = client.compact(COLLECTION)
        for _ in range(600):
            if client.get_compaction_state(job) == "Completed":
                return
            time.sleep(2)
    except Exception as e:  # noqa: BLE001
        print(f"compaction skipped: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default=DEFAULT_PARQUET)
    ap.add_argument("--drop", action="store_true")
    ap.add_argument("--schema-only", action="store_true")
    ap.add_argument("--reanchor", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    rules = synth.read_synonyms(os.path.join(HERE, "synonyms.txt"))
    ep, tok = load_env()
    client = MilvusClient(uri=ep, token=tok)

    if a.schema_only:
        print(build_schema(client, rules))
        return

    table = pq.read_table(a.parquet)
    total = min(table.num_rows, a.limit) if a.limit else table.num_rows

    if a.reanchor:
        if not client.has_collection(COLLECTION):
            sys.exit(f"{COLLECTION} does not exist; run without --reanchor first")
        # Re-upsert only the date column so "listed within 30 days" is live again.
        # Upsert needs the full row on serverless, so we re-send full rows.
        print(f"re-anchoring first_seen for {total} rows")
        for start in range(0, total, BATCH):
            client.upsert(COLLECTION, rows_from(table, start, min(start + BATCH, total)))
            print(f"  {min(start + BATCH, total)}/{total}", end="\r", flush=True)
        client.flush(COLLECTION)
        print("\ndone")
        return

    if client.has_collection(COLLECTION):
        if not a.drop:
            sys.exit(f"{COLLECTION} exists; pass --drop to recreate")
        client.drop_collection(COLLECTION)
    client.create_collection(COLLECTION, schema=build_schema(client, rules))
    create_indexes(client)

    t0 = time.time()
    for start in range(0, total, BATCH):
        client.insert(COLLECTION, rows_from(table, start, min(start + BATCH, total)))
        print(f"  inserted {min(start + BATCH, total)}/{total}", end="\r", flush=True)
    print(f"\ninsert took {time.time() - t0:.0f}s; flushing")
    client.flush(COLLECTION)
    wait_compaction(client)
    client.load_collection(COLLECTION)
    print("rows:", client.get_collection_stats(COLLECTION)["row_count"])
    for f in ("text_vec", "text_sparse", "store_location"):
        print(f, client.describe_index(COLLECTION, f).get("index_type"))


if __name__ == "__main__":
    main()
