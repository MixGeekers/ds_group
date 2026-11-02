"""Real pinned Ombre SQLite + real loopback HTTP, without inference or SDK mocks.

Run from plugins/shiyu with its pinned environment:
  .local/ombre/.venv/bin/python -B -m unittest discover -s service/ombre/tests -p test_harrier_profile.py -v
The only synthetic runtime files are under .local/ombre/harrier-tests and removed.
"""
from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
UPSTREAM = PLUGIN_ROOT / ".local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935/src"
sys.path.insert(0, str(UPSTREAM))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import embedding_engine as upstream
from harrier_profile import (HARRIER_PROFILE, PROFILE_FINGERPRINT, HarrierProfileError,
                             create_harrier_engine_class, normalize_vector, prepare_input, validate_endpoint)


def unit_vector(index=0):
    return [1.0 if position == index else 0.0 for position in range(1024)]


class Fixture:
    def __init__(self):
        self.calls = []
        self.status = 200
        self.response = None
        self.delay = 0
        self.chunk_delay = 0
        self.content_type = "application/json"
        self.redirect = "https://example.invalid/never"
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.calls.append({"body": body, "path": self.path, "authorization": self.headers.get("Authorization")})
                if fixture.delay:
                    time.sleep(fixture.delay)
                vector = unit_vector(0 if body["input"][0].startswith(HARRIER_PROFILE["query_prefix"]) else 1)
                response = fixture.response if fixture.response is not None else {
                    "model": HARRIER_PROFILE["model"], "data": [{"index": 0, "embedding": vector}]}
                payload = response if isinstance(response, bytes) else json.dumps(response).encode()
                self.send_response(fixture.status)
                self.send_header("Content-Type", fixture.content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Location", fixture.redirect)
                self.end_headers()
                try:
                    if fixture.chunk_delay:
                        for offset in range(0, len(payload), 16):
                            self.wfile.write(payload[offset:offset + 16])
                            self.wfile.flush()
                            time.sleep(fixture.chunk_delay)
                    else:
                        self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}/v1/embeddings"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class HarrierTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runtime = PLUGIN_ROOT / ".local/ombre/harrier-tests"
        runtime.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="case-", dir=runtime)
        self.addCleanup(self.temp.cleanup)
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.config = {"buckets_dir": self.temp.name, "embedding": {"enabled": True, "api_format": "shiyu_harrier"}}
        self.engine_class = create_harrier_engine_class(upstream, endpoint=self.fixture.endpoint)

    def engine(self, **options):
        if options:
            return create_harrier_engine_class(upstream, endpoint=self.fixture.endpoint, **options)(self.config)
        return self.engine_class(self.config)

    def query_db(self, statement, args=()):
        with sqlite3.connect(Path(self.temp.name) / "embeddings.db") as connection:
            return connection.execute(statement, args).fetchall()

    async def test_real_upstream_storage_content_meaning_query_and_role_cache(self):
        engine = self.engine()
        self.assertEqual(self.fixture.calls, [])  # Construction makes no request.
        text = "合成记忆 / synthetic memory"
        self.assertTrue(await engine.generate_and_store("synthetic-a", text))
        self.assertTrue(await engine.generate_and_store_meaning("synthetic-a", text))
        # Content/meaning share the document representation, but query must not.
        self.assertEqual(len(self.fixture.calls), 1)
        result = await engine.search_similar_strict(text)
        self.assertEqual(result, [("synthetic-a", 0.0)])
        self.assertEqual(await engine.search(text), ["synthetic-a"])
        self.assertEqual(len(self.fixture.calls), 2)
        self.assertEqual(self.fixture.calls[0]["body"]["input"], [text])
        self.assertEqual(self.fixture.calls[1]["body"]["input"], [HARRIER_PROFILE["query_prefix"] + text])
        self.assertTrue(all(call["path"] == "/v1/embeddings" and call["authorization"] is None for call in self.fixture.calls))
        rows = self.query_db("SELECT embedding,meaning_embedding,content_hash FROM embeddings")
        self.assertEqual(len(rows[0][0]), 4096)
        self.assertEqual(len(rows[0][1]), 4096)
        self.assertEqual(len(rows[0][2]), 64)
        self.assertEqual((await engine.get_embedding("synthetic-a")), unit_vector(1))
        self.assertEqual(engine.status()["profile_fingerprint"], PROFILE_FINGERPRINT)

    async def test_only_explicit_local_api_key_is_sent_and_environment_is_ignored(self):
        key = "synthetic-local-key_0123456789"
        environment_key = "synthetic-ambient-key-must-not-be-used"
        with patch.dict("os.environ", {"OPENAI_API_KEY": environment_key, "LLAMA_API_KEY": environment_key,
                                       "OMBRE_EMBED_API_KEY": environment_key,
                                       "OMBRE_OLLAMA_URL": "https://example.invalid/v1"}):
            for configured_key in (None, key):
                engine = self.engine(api_key=configured_key)
                self.assertEqual(engine._backend.request_count, 0)
                await engine._generate_async("synthetic authenticated document")
                call = self.fixture.calls[-1]
                self.assertEqual(call["authorization"], None if configured_key is None else "Bearer " + key)
                self.assertEqual(call["path"], "/v1/embeddings")
                self.assertNotIn(key, json.dumps(call["body"]))
                self.assertEqual(engine.profile_fingerprint, PROFILE_FINGERPRINT)
                self.assertEqual(dict(engine.profile), dict(HARRIER_PROFILE))
                self.assertNotIn(key, json.dumps(engine.status()))
                self.assertNotIn(key, json.dumps(self.query_db("SELECT key,value FROM embeddings_meta")))
        self.assertEqual(len(self.fixture.calls), 2)

    async def test_api_key_not_leaked_by_errors_logs_or_redirects(self):
        key = "synthetic-private-endpoint-key"
        engine = self.engine(api_key=key)
        self.fixture.status = 500
        self.fixture.response = {"secret": key}
        with self.assertLogs("ombre_brain.embedding", level="WARNING") as captured:
            self.assertFalse(await engine.generate_and_store("synthetic-failure", "synthetic document"))
        self.assertNotIn(key, "\n".join(captured.output))
        self.assertNotIn(key, json.dumps(engine.status()))
        self.assertEqual(engine._backend.request_count, 1)
        redirected = Fixture()
        self.addCleanup(redirected.close)
        self.fixture.status = 302
        self.fixture.redirect = redirected.endpoint
        with self.assertRaises(HarrierProfileError) as caught:
            await engine._generate_async("synthetic redirected document")
        self.assertEqual(caught.exception.code, "ENDPOINT_FAILURE")
        self.assertNotIn(key, str(caught.exception))
        self.assertEqual(engine._backend.request_count, 2)
        self.assertEqual(len(self.fixture.calls), 2)
        self.assertEqual(redirected.calls, [])

    async def test_request_counter_is_read_only_and_counts_attempts_not_cache_hits(self):
        engine = self.engine()
        self.assertEqual(engine._backend.request_count, 0)
        with self.assertRaises(AttributeError):
            engine._backend.request_count = 7
        with self.assertRaisesRegex(HarrierProfileError, "INVALID_INPUT"):
            await engine._generate_async(" ")
        self.assertEqual(engine._backend.request_count, 0)
        await engine._generate_async("same", role="document")
        await engine._generate_async("same", role="document")
        self.assertEqual(engine._backend.request_count, 1)
        await engine._generate_async("same", role="query")
        self.assertEqual(engine._backend.request_count, 2)
        self.fixture.status = 500
        for expected_count in (3, 4):
            with self.assertRaisesRegex(HarrierProfileError, "ENDPOINT_FAILURE"):
                await engine._generate_async("failed request")
            self.assertEqual(engine._backend.request_count, expected_count)
        await engine._generate_async("same", role="document")
        self.assertEqual(engine._backend.request_count, 4)
        self.assertEqual(len(self.fixture.calls), 4)

    def test_api_key_requires_bounded_visible_ascii_without_whitespace(self):
        for key in ("", "a" * 257, "with space", "a\tb", "a\nb", "a\rb", "a\0b", "a\x7fb", "中文", 1, True, b"key"):
            with self.subTest(key_type=type(key).__name__), self.assertRaisesRegex(HarrierProfileError, "INVALID_CONFIG"):
                self.engine(api_key=key)
        for key in ("!", "~" * 256):
            engine = self.engine(api_key=key)
            self.assertEqual(engine._backend.request_count, 0)
        self.assertEqual(self.fixture.calls, [])

    async def test_head2000_before_prefix_and_only_actual_input_is_cached(self):
        engine = self.engine()
        prefix = "语" * 2000
        await engine._generate_async(prefix + "private-tail-A", role="query")
        await engine._generate_async(prefix + "private-tail-B", role="query")
        await engine._generate_async(prefix, role="document")
        self.assertEqual(len(self.fixture.calls), 2)
        self.assertEqual(self.fixture.calls[0]["body"]["input"], [HARRIER_PROFILE["query_prefix"] + prefix])
        self.assertEqual(self.fixture.calls[1]["body"]["input"], [prefix])
        self.assertTrue(all(len(key) == 64 for key in engine._query_cache))
        self.assertNotIn("private-tail", repr(engine._query_cache))

    async def test_roles_isolated_across_concurrent_upstream_calls(self):
        engine = self.engine()
        engine._store_embedding("seed", unit_vector(0))
        await asyncio.gather(engine.search_similar_strict("same"),
                             engine.generate_and_store("new", "same"),
                             engine.generate_and_store_meaning("meaning", "other"))
        inputs = sorted(call["body"]["input"][0] for call in self.fixture.calls)
        self.assertEqual(inputs, sorted([HARRIER_PROFILE["query_prefix"] + "same", "same", "other"]))
        self.assertEqual(engine._input_role.get(), "document")
        self.assertEqual(engine._backend.request_count, 3)

    async def test_empty_index_initializes_and_nonempty_profile_is_required(self):
        engine = self.engine()
        meta = dict(self.query_db("SELECT key,value FROM embeddings_meta"))
        self.assertEqual(meta["shiyu_embedding_profile_sha256"], PROFILE_FINGERPRINT)
        self.assertEqual(meta["vector_dim"], "1024")
        # A meaning-only row is nonempty, too.
        self.assertTrue(await engine.generate_and_store_meaning("meaning-only", "synthetic meaning"))
        before = self.query_db("SELECT embedding,meaning_embedding FROM embeddings")
        self.query_db("DELETE FROM embeddings_meta WHERE key='shiyu_embedding_profile_sha256'")
        with self.assertRaisesRegex(HarrierProfileError, "REINDEX_REQUIRED"):
            self.engine()
        self.assertEqual(self.query_db("SELECT embedding,meaning_embedding FROM embeddings"), before)
        with self.assertRaisesRegex(HarrierProfileError, "REINDEX_REQUIRED"):
            await engine._generate_async("must not call HTTP")
        self.assertEqual(len(self.fixture.calls), 1)

    async def test_same_model_wrong_dimension_and_changed_profile_refused(self):
        engine = self.engine()
        engine._store_embedding("seed", unit_vector())
        for key, value in [("vector_dim", "512"), ("shiyu_embedding_profile", "{}"),
                           ("shiyu_embedding_profile_sha256", "changed")]:
            original = dict(self.query_db("SELECT key,value FROM embeddings_meta"))[key]
            self.query_db("UPDATE embeddings_meta SET value=? WHERE key=?", (value, key))
            with self.assertRaisesRegex(HarrierProfileError, "REINDEX_REQUIRED"):
                self.engine()
            self.query_db("UPDATE embeddings_meta SET value=? WHERE key=?", (original, key))
        self.assertEqual(engine._backend.vector_dim(), 1024)
        self.assertEqual(self.fixture.calls, [])

    async def test_corrupt_stored_vector_cannot_reopen_as_compatible(self):
        engine = self.engine()
        engine._store_embedding("seed", unit_vector())
        for vector in ([1.0] * 512, [0.0] * 1024, [float("nan")] * 1024):
            self.query_db("UPDATE embeddings SET embedding=?", (json.dumps(vector),))
            with self.assertRaisesRegex(HarrierProfileError, "REINDEX_REQUIRED"):
                self.engine()
        self.assertEqual(self.fixture.calls, [])

    async def test_provider_vector_failure_not_cached_or_written_or_auto_resized(self):
        engine = self.engine()
        for index, vector in enumerate(([1.0] * 512, [0.0] * 1024, [float("nan")] * 1024,
                                        [float("inf")] * 1024, [True] * 1024, [10**400] + [0.0] * 1023)):
            self.fixture.response = {"data": [{"index": 0, "embedding": vector}]}
            self.assertFalse(await engine.generate_and_store(f"bad-{index}", f"synthetic {index}"))
            self.assertEqual(engine._backend.vector_dim(), 1024)
        self.assertEqual(self.query_db("SELECT COUNT(*) FROM embeddings"), [(0,)])
        self.assertEqual(len(engine._query_cache), 0)
        self.assertEqual(engine.status()["last_error_code"], "INVALID_VECTOR")

    async def test_http_errors_no_retry_redirect_or_secret_leak(self):
        engine = self.engine()
        for status in (429, 500, 302):
            self.fixture.status = status
            self.fixture.response = {"secret": "synthetic-private-provider-body"}
            previous = len(self.fixture.calls)
            with self.assertRaises(HarrierProfileError) as caught:
                await engine._generate_async(f"status {status}")
            self.assertEqual(caught.exception.code, "ENDPOINT_FAILURE")
            self.assertNotIn("private", str(caught.exception))
            self.assertEqual(len(self.fixture.calls), previous + 1)

    async def test_timeout_single_attempt_and_role_reset(self):
        engine = self.engine(timeout_seconds=0.03)
        engine._store_embedding("seed", unit_vector())
        self.fixture.delay = 0.1
        with self.assertRaisesRegex(HarrierProfileError, "ENDPOINT_FAILURE"):
            await engine.search_similar_strict("timeout synthetic")
        self.assertEqual(len(self.fixture.calls), 1)
        self.assertEqual(engine._input_role.get(), "document")
        self.assertEqual(engine.status()["last_error_code"], "ENDPOINT_FAILURE")
        self.assertEqual(engine._backend.request_count, 1)

    async def test_total_deadline_bounds_slow_trickling_response(self):
        engine = self.engine(timeout_seconds=0.05)
        self.fixture.chunk_delay = 0.01
        started = time.monotonic()
        with self.assertRaisesRegex(HarrierProfileError, "ENDPOINT_FAILURE"):
            await engine._generate_async("slow stream")
        self.assertLess(time.monotonic() - started, 0.3)
        self.assertEqual(len(self.fixture.calls), 1)

    async def test_profile_change_across_await_discards_returned_vector(self):
        engine = self.engine()
        self.fixture.delay = 0.1
        task = asyncio.create_task(engine._generate_async("synthetic pending"))
        async with asyncio.timeout(1):
            while not self.fixture.calls:
                await asyncio.sleep(0.001)
        self.query_db("UPDATE embeddings_meta SET value='changed' WHERE key='shiyu_embedding_profile_sha256'")
        with self.assertRaisesRegex(HarrierProfileError, "REINDEX_REQUIRED"):
            await task
        self.assertEqual(len(engine._query_cache), 0)
        self.assertEqual(self.query_db("SELECT COUNT(*) FROM embeddings"), [(0,)])

    async def test_proxy_environment_is_ignored_and_success_clears_error(self):
        engine = self.engine()
        engine._last_error_code = "ENDPOINT_FAILURE"
        with patch.dict("os.environ", {"HTTP_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1",
                                       "NO_PROXY": "", "OMBRE_OLLAMA_URL": "https://example.invalid/v1"}):
            vector = await engine._generate_async("synthetic local")
        self.assertEqual(vector, unit_vector(1))
        self.assertEqual(engine.status()["last_error_code"], None)
        self.assertEqual(len(self.fixture.calls), 1)

    async def test_response_shape_size_and_content_type_bounds(self):
        engine = self.engine()
        cases = [{"data": []}, {"data": [{"index": 1, "embedding": unit_vector()}]},
                 {"model": "different", "data": [{"index": 0, "embedding": unit_vector()}]},
                 b"not JSON", b" " * (128 * 1024 + 1)]
        for index, response in enumerate(cases):
            self.fixture.response = response
            with self.assertRaisesRegex(HarrierProfileError, "INVALID_RESPONSE"):
                await engine._generate_async(f"shape {index}")
        self.fixture.response = None
        self.fixture.content_type = "text/plain"
        with self.assertRaisesRegex(HarrierProfileError, "INVALID_RESPONSE"):
            await engine._generate_async("content-type")

    async def test_cache_bounded_and_returns_copies(self):
        engine = self.engine()
        vector = await engine._generate_async("synthetic cached")
        vector[1] = 99
        self.assertEqual((await engine._generate_async("synthetic cached"))[1], 1)
        for index in range(33):
            await engine._generate_async(f"distinct synthetic {index}")
        self.assertEqual(len(engine._query_cache), 32)

    def test_endpoint_profile_and_configuration_are_pinned(self):
        self.assertEqual(validate_endpoint("http://[::1]:1234/v1/embeddings"), "http://[::1]:1234/v1/embeddings")
        for value in (None, 1, "http://localhost:1234/v1/embeddings", "https://127.0.0.1:1234/v1/embeddings",
                      "http://127.0.0.1/v1/embeddings", "http://127.0.0.1:1234/v1/embeddings?q=x",
                      "http://user@127.0.0.1:1234/v1/embeddings", "http://example.invalid:1234/v1/embeddings"):
            with self.subTest(endpoint=value), self.assertRaises(HarrierProfileError):
                validate_endpoint(value)
        with self.assertRaisesRegex(HarrierProfileError, "INVALID_PROFILE"):
            create_harrier_engine_class(upstream, endpoint=self.fixture.endpoint, profile={**HARRIER_PROFILE, "dimensions": 512})
        for change in ({"dim": 512}, {"model": "bge-m3"}, {"api_format": "ollama"},
                       {"base_url": "https://example.invalid/v1"}):
            with self.subTest(change=change), self.assertRaises(HarrierProfileError):
                self.engine_class({**self.config, "embedding": {**self.config["embedding"], **change}})
        self.assertNotIn("server", sys.modules)
        self.assertEqual(self.fixture.calls, [])

    def test_normalization_is_finite_and_input_prefix_exact(self):
        vector = normalize_vector([1e308] * 1024)
        self.assertTrue(all(math.isfinite(value) for value in vector))
        self.assertAlmostEqual(math.fsum(value * value for value in vector), 1.0)
        self.assertEqual(prepare_input("中文", "query"), HARRIER_PROFILE["query_prefix"] + "中文")
        for text, role in ((" ", "document"), ("hello", "wrong"), (123, "query")):
            with self.assertRaises(HarrierProfileError):
                prepare_input(text, role)


if __name__ == "__main__":
    unittest.main()
