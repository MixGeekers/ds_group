"""Pinned local Harrier boundary for Ombre Brain 3.6.14 / 115d831d979b.

This independently written adapter subclasses upstream ``EmbeddingEngine``;
SQLite storage, ranking, content/meaning columns and outbox remain upstream.
Audited seams: embedding_engine.py:407,563,723,798,814,851,977.
No server import, process management, SDK, cloud fallback or online migration.

The Ombre profile deliberately keeps its head-2000-codepoints input policy,
then adds the evaluated query instruction. The TypeScript client instead rejects
oversized input without truncation. These are distinct index profiles. HTTP
model names cannot attest loaded weights: the trusted launcher must separately
verify the pinned GGUF and llama-server before enabling this adapter.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import hashlib
import json
import math
import sqlite3
from types import MappingProxyType
from urllib.parse import urlsplit

import httpx


HARRIER_PROFILE = MappingProxyType({
    "id": "harrier-oss-v1-0.6b-q8_0-1024-ombre-head2000-v1",
    "model": "shiyu-harrier-0.6b-q8_0",
    "artifact_sha256": "b017b8fceae7c77864652c63d07af51480088b078771a89cafe1a467b069ea75",
    "upstream_revision": "f9b9dc8d367d443f2479d27aa5d8d2850c0774ee",
    "dimensions": 1024,
    "pooling": "last",
    "normalization": "l2",
    "query_prefix": "Instruct: Given a user query about personal chat memories, retrieve the most relevant memory entries that answer the query\nQuery: ",
    "document_prefix": "",
    "input_policy": "head-2000-unicode-codepoints-before-prefix",
})
_PROFILE_JSON = json.dumps(dict(HARRIER_PROFILE), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
PROFILE_FINGERPRINT = hashlib.sha256(_PROFILE_JSON.encode("utf-8")).hexdigest()
_META_KEY = "shiyu_embedding_profile_sha256"
_MAX_RESPONSE_BYTES = 128 * 1024
_CACHE_LIMIT = 32


class HarrierProfileError(RuntimeError):
    """Bounded diagnostic; never includes provider bodies or memory content."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


def validate_endpoint(endpoint: str) -> str:
    if not isinstance(endpoint, str):
        raise HarrierProfileError("INVALID_ENDPOINT", "Expected explicit loopback embedding endpoint")
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except (TypeError, ValueError):
        raise HarrierProfileError("INVALID_ENDPOINT", "Expected explicit loopback embedding endpoint") from None
    if (not isinstance(endpoint, str) or parsed.scheme != "http"
            or parsed.hostname not in ("127.0.0.1", "::1") or not port
            or parsed.username is not None or parsed.password is not None
            or parsed.path != "/v1/embeddings" or parsed.query or parsed.fragment
            or any(character.isspace() for character in endpoint)):
        raise HarrierProfileError("INVALID_ENDPOINT", "Expected http loopback IP, explicit port and /v1/embeddings")
    return endpoint


def normalize_vector(value) -> list[float]:
    try:
        valid = (isinstance(value, list) and len(value) == HARRIER_PROFILE["dimensions"]
                 and all(not isinstance(item, bool) and isinstance(item, (int, float))
                         and math.isfinite(item) for item in value))
    except (ValueError, OverflowError):
        valid = False
    if not valid:
        raise HarrierProfileError("INVALID_VECTOR", "Expected exactly 1024 finite numbers")
    scale = max(abs(item) for item in value)
    if scale == 0:
        raise HarrierProfileError("INVALID_VECTOR", "Expected nonzero vector norm")
    scaled = [item / scale for item in value]
    norm = math.sqrt(math.fsum(item * item for item in scaled))
    return [item / norm for item in scaled]


def prepare_input(text: str, role: str) -> str:
    if role not in ("query", "document") or not isinstance(text, str):
        raise HarrierProfileError("INVALID_INPUT", "Expected query/document role and text")
    bounded = text[:2000]
    if not bounded.strip():
        raise HarrierProfileError("INVALID_INPUT", "Embedding input is empty after applying input policy")
    return HARRIER_PROFILE[f"{role}_prefix"] + bounded


class _LocalBackend:
    def __init__(self, endpoint: str, timeout_seconds: float):
        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds

    def model_name(self) -> str:
        return HARRIER_PROFILE["model"]

    def vector_dim(self) -> int:
        return HARRIER_PROFILE["dimensions"]

    def generate(self, text: str) -> list[float]:
        # Upstream production uses async; do not create a coroutine in an active loop.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.generate_async(text))
        raise HarrierProfileError("ASYNC_REQUIRED", "Use the asynchronous embedding interface")

    async def generate_async(self, prepared_text: str) -> list[float]:
        payload = {"model": self.model_name(), "input": [prepared_text], "encoding_format": "float"}
        try:
            # HTTPX transport defaults to zero retries. No SDK, proxy environment,
            # redirects, authentication secrets or persistent owned connection.
            async with asyncio.timeout(self.timeout_seconds), httpx.AsyncClient(
                    timeout=self.timeout_seconds, trust_env=False, follow_redirects=False) as client:
                async with client.stream("POST", self.endpoint, json=payload,
                                         headers={"Accept": "application/json"}) as response:
                    if response.status_code != 200:
                        raise HarrierProfileError("ENDPOINT_FAILURE", "Embedding endpoint rejected the request")
                    if "application/json" not in response.headers.get("content-type", "").lower():
                        raise HarrierProfileError("INVALID_RESPONSE", "Embedding response must be JSON")
                    chunks, length = [], 0
                    async for chunk in response.aiter_bytes():
                        length += len(chunk)
                        if length > _MAX_RESPONSE_BYTES:
                            raise HarrierProfileError("INVALID_RESPONSE", "Embedding response exceeds byte limit")
                        chunks.append(chunk)
                    raw = json.loads(b"".join(chunks))
        except (httpx.HTTPError, TimeoutError):
            raise HarrierProfileError("ENDPOINT_FAILURE", "Embedding request failed") from None
        except (ValueError, UnicodeError):
            raise HarrierProfileError("INVALID_RESPONSE", "Embedding response is invalid JSON") from None
        if (not isinstance(raw, dict)
                or raw.get("model", self.model_name()) != self.model_name()
                or not isinstance(raw.get("data"), list) or len(raw["data"]) != 1):
            raise HarrierProfileError("INVALID_RESPONSE", "Embedding response model or item count differs")
        item = raw["data"][0]
        if not isinstance(item, dict) or type(item.get("index")) is not int or item["index"] != 0:
            raise HarrierProfileError("INVALID_RESPONSE", "Embedding response must contain index zero")
        return normalize_vector(item.get("embedding"))


def create_harrier_engine_class(upstream_module, *, endpoint: str, profile=None,
                                timeout_seconds: float = 15.0):
    """Return a trusted, explicitly configured upstream engine subclass.

    The caller loads only the pinned upstream embedding module, then constructs
    this class with the normal Ombre config. It must not import ``server`` or
    expose upstream provider/migration/Ollama management routes. ``profile`` is
    a consistency assertion, not model-controlled configuration. A nonempty
    legacy/incompatible index raises REINDEX_REQUIRED without rewriting vectors.
    """
    endpoint = validate_endpoint(endpoint)
    if profile is not None and profile != dict(HARRIER_PROFILE):
        raise HarrierProfileError("INVALID_PROFILE", "Only the pinned Harrier profile is supported")
    if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 60):
        raise HarrierProfileError("INVALID_CONFIG", "Timeout must be positive and at most 60 seconds")
    base_class = upstream_module.EmbeddingEngine

    class HarrierEmbeddingEngine(base_class):
        profile = HARRIER_PROFILE
        profile_fingerprint = PROFILE_FINGERPRINT

        def __init__(self, config: dict):
            embedding = config.get("embedding", {}) or {}
            if not isinstance(embedding, dict):
                raise HarrierProfileError("INVALID_CONFIG", "Embedding config must be an object")
            expected = {"model": HARRIER_PROFILE["model"], "dim": 1024, "api_format": "shiyu_harrier"}
            for key, value in expected.items():
                if key in embedding and (embedding[key] != value or isinstance(embedding[key], bool)):
                    raise HarrierProfileError("INVALID_PROFILE", "Embedding configuration differs from pinned profile")
            if "base_url" in embedding and embedding["base_url"] not in (endpoint, endpoint.removesuffix("/embeddings")):
                raise HarrierProfileError("INVALID_ENDPOINT", "Config endpoint differs from trusted binding")
            self._input_role = ContextVar(f"harrier_input_role_{id(self)}", default="document")
            self._last_error_code = None
            # Disabled parent initialization creates upstream tables without ever
            # constructing its cloud/Ollama providers or mutating caller config.
            super().__init__({**config, "embedding": {**embedding, "enabled": False}})
            self._backend = _LocalBackend(endpoint, float(timeout_seconds))
            self.backend = "shiyu_harrier"
            self.api_format = "shiyu_harrier"
            self.model = HARRIER_PROFILE["model"]
            self.enabled = upstream_module.parse_bool(embedding.get("enabled", True), default=True)

        def _init_db(self):
            # Keep upstream tables/codec; skip automatic old-vector backfill or
            # corrupt-index replacement before the compatibility decision.
            self._create_tables()
            self._check_meta_consistency()
            self._validate_existing_vectors()

        def _check_meta_consistency(self):
            expected_meta = {_META_KEY: PROFILE_FINGERPRINT, "shiyu_embedding_profile": _PROFILE_JSON,
                             "model_name": HARRIER_PROFILE["model"], "vector_dim": "1024"}
            with sqlite3.connect(self.db_path) as connection:
                connection.execute("BEGIN IMMEDIATE")
                count = connection.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
                meta = dict(connection.execute("SELECT key, value FROM embeddings_meta"))
                if count:
                    if any(meta.get(key) != value for key, value in expected_meta.items()):
                        raise HarrierProfileError("REINDEX_REQUIRED", "Nonempty index has missing or incompatible embedding profile")
                else:
                    connection.executemany("INSERT OR REPLACE INTO embeddings_meta(key,value) VALUES (?,?)", expected_meta.items())

        def _assert_profile(self):
            meta = self._read_meta()
            if (meta.get(_META_KEY) != PROFILE_FINGERPRINT
                    or meta.get("shiyu_embedding_profile") != _PROFILE_JSON
                    or meta.get("model_name") != HARRIER_PROFILE["model"] or meta.get("vector_dim") != "1024"):
                self._query_cache.clear()
                self._last_error_code = "REINDEX_REQUIRED"
                raise HarrierProfileError("REINDEX_REQUIRED", "Index profile changed; semantic access is blocked")

        def _validate_existing_vectors(self):
            # Startup integrity check only; ranking remains entirely upstream.
            with sqlite3.connect(self.db_path) as connection:
                cursor = connection.execute("SELECT embedding,meaning_embedding FROM embeddings")
                while rows := cursor.fetchmany(32):
                    for row in rows:
                        for raw in row:
                            if raw is None or raw == "":
                                continue
                            try:
                                normalize_vector(upstream_module.decode_vector(raw).tolist())
                            except (ValueError, TypeError, HarrierProfileError):
                                raise HarrierProfileError("REINDEX_REQUIRED", "Stored vector violates the pinned profile") from None

        async def _generate_async(self, text: str, *, role: str | None = None):
            self._assert_profile()
            if not self.enabled:
                raise HarrierProfileError("DISABLED", "Harrier embedding is disabled")
            role = self._input_role.get() if role is None else role
            prepared = prepare_input(text, role)
            identity = hashlib.sha256((PROFILE_FINGERPRINT + "\0" + role + "\0" + prepared).encode("utf-8")).hexdigest()
            cached = self._query_cache.get(identity)
            if cached is not None:
                self._query_cache.move_to_end(identity)
                return list(cached)
            try:
                vector = await self._backend.generate_async(prepared)
            except HarrierProfileError as error:
                self._last_error_code = error.code
                raise
            self._assert_profile()  # A profile change across the HTTP await invalidates the result.
            self._last_error_code = None
            self._query_cache[identity] = list(vector)
            self._query_cache.move_to_end(identity)
            if len(self._query_cache) > _CACHE_LIMIT:
                self._query_cache.popitem(last=False)
            return vector

        async def generate_and_store(self, bucket_id, content):
            self._assert_profile()
            token = self._input_role.set("document")
            try:
                return await super().generate_and_store(bucket_id, content)
            finally:
                self._input_role.reset(token)

        async def generate_and_store_meaning(self, bucket_id, meaning_text):
            self._assert_profile()
            token = self._input_role.set("document")
            try:
                return await super().generate_and_store_meaning(bucket_id, meaning_text)
            finally:
                self._input_role.reset(token)

        def _store_embedding(self, bucket_id, embedding, content_hash=""):
            self._assert_profile()
            return super()._store_embedding(bucket_id, normalize_vector(embedding), content_hash)

        def _store_meaning_embedding(self, bucket_id, embedding):
            self._assert_profile()
            return super()._store_meaning_embedding(bucket_id, normalize_vector(embedding))

        async def get_embedding(self, bucket_id):
            self._assert_profile()
            vector = await super().get_embedding(bucket_id)
            return normalize_vector(vector) if vector is not None else None

        async def search_similar_strict(self, query, top_k=10, allowed_bucket_ids=None):
            self._assert_profile()
            token = self._input_role.set("query")
            try:
                return await super().search_similar_strict(query, top_k=top_k, allowed_bucket_ids=allowed_bucket_ids)
            finally:
                self._input_role.reset(token)

        def status(self):
            return {**super().status(), "profile_id": HARRIER_PROFILE["id"],
                    "profile_fingerprint": PROFILE_FINGERPRINT,
                    "last_error_code": self._last_error_code,
                    "input_policy": HARRIER_PROFILE["input_policy"]}

    return HarrierEmbeddingEngine
