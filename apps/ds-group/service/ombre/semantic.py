"""Explicit, bounded derived indexing over pinned native Ombre storage/ranking.

No second vector engine, body store, background worker, write replay or recovery
on reads. Index receipts bind native file/body and both vector columns; the
separate journal/watermark is not a body receipt or a control-domain ACL.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import quote
import uuid

from controlled_store import _sync_directory
from harrier_profile import PROFILE_FINGERPRINT, HarrierProfileError, normalize_vector
from protocol import ProtocolError, HEX, canonical, identifier, sha256

LIMITS = {"maxEligibleRefs": 128, "maxScannedRows": 2048, "maxResults": 10,
          "maxEmbeddingCallsPerIndex": 2, "maxDeadlineMs": 60000}
COMMAND_KEYS = {"schemaVersion", "kind", "indexOperationId", "memoryOperationId", "bodyReceiptId", "backendId",
                "deploymentId", "scope", "nativeId", "componentVersion", "bodyDigest", "profileFingerprint",
                "indexBaselineId", "expectedIndexWatermark", "deadlineAtMs", "maxEmbeddingCalls"}
REF_KEYS = {"memoryOperationId", "bodyReceiptId", "nativeId", "componentVersion", "bodyDigest"}
MAX_SAFE = 9007199254740991


def _fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ProtocolError("INVALID_SEMANTIC_INPUT")


def _integer(value, minimum=0, maximum=MAX_SAFE):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ProtocolError("INVALID_SEMANTIC_INPUT")
    return value


def _match(value, pattern):
    if not isinstance(value, str) or re.fullmatch(pattern, value, re.ASCII) is None:
        raise ProtocolError("INVALID_SEMANTIC_INPUT")


def _ref(value):
    _fields(value, REF_KEYS)
    identifier(value["memoryOperationId"], operation=True)
    _match(value["bodyReceiptId"], r"receipt_[a-f0-9]{64}")
    _match(value["nativeId"], r"shiyu_[a-f0-9]{32}")
    _match(value["componentVersion"], r"sha256:[a-f0-9]{64}")
    _match(value["bodyDigest"], r"[a-f0-9]{64}")


def _deadline(value):
    _integer(value, 1)
    remaining = value / 1000 - time.time()
    if remaining <= 0:
        raise ProtocolError("DEADLINE_EXCEEDED")
    if remaining > 60:
        raise ProtocolError("INVALID_DEADLINE")
    return asyncio.timeout(remaining)


def _within(budget):
    # Native async get/cache-hit/ranking methods can execute synchronously;
    # timeout cancellation alone cannot guard publication after those turns.
    if asyncio.get_running_loop().time() >= budget.when():
        raise ProtocolError("DEADLINE_EXCEEDED")


class SemanticIndex:
    def __init__(self, store):
        self.store = store
        self.engine = store.manager.embedding_engine
        if self.engine is None or not self.engine.enabled:
            raise ProtocolError("EMBEDDING_REQUIRED")
        self.db = None
        self.path = store.meta_dir / "semantic.sqlite3"
        if self.path.is_symlink():
            raise ProtocolError("UNSAFE_JOURNAL")
        marker_table = store._db.execute("SELECT 1 FROM sqlite_master WHERE name='semantic_installation'").fetchone()
        existed = self.path.exists()
        if bool(marker_table) != existed:
            raise ProtocolError("INDEX_BASELINE_MISSING")
        try:
            if not existed:
                if self._scan_count():
                    raise ProtocolError("REINDEX_REQUIRED")
                self.db = sqlite3.connect(self.path, isolation_level=None)
                self.db.row_factory = sqlite3.Row
                self.db.executescript("""
                    PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                    BEGIN IMMEDIATE;
                    CREATE TABLE meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),binding TEXT NOT NULL,
                        baseline TEXT NOT NULL,profile TEXT NOT NULL,watermark INTEGER NOT NULL);
                    CREATE TABLE index_operations(operation_id TEXT PRIMARY KEY,command_json TEXT NOT NULL,digest TEXT NOT NULL,
                        state TEXT NOT NULL CHECK(state IN ('unknown','applied')),receipt_json TEXT,watermark INTEGER UNIQUE,
                        error TEXT,calls INTEGER,usage_complete INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE entries(native_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES index_operations(operation_id));
                    COMMIT;
                """)
                baseline = "index_" + uuid.uuid4().hex
                self.db.execute("INSERT INTO meta VALUES(1,?,?,?,0)", (canonical(self._binding()), baseline, PROFILE_FINGERPRINT))
                _sync_directory(store.meta_dir)
                # A separate marker in the existing metadata journal detects a
                # missing derived journal even when its vector table is empty.
                store._db.execute("BEGIN IMMEDIATE")
                try:
                    store._db.execute("CREATE TABLE semantic_installation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),baseline TEXT NOT NULL)")
                    store._db.execute("INSERT INTO semantic_installation VALUES(1,?)", (baseline,))
                    store._db.execute("COMMIT")
                except BaseException:
                    store._db.execute("ROLLBACK")
                    raise
            else:
                self.db = sqlite3.connect(self.path, isolation_level=None)
                self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA synchronous=FULL")
            self._meta()
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None

    def _binding(self):
        return {"schemaVersion": 2, "backendId": self.store.backend_id,
                "deploymentId": self.store.deployment_id, "scope": self.store.scope}

    def _meta(self):
        if self.db is None:
            raise ProtocolError("SERVICE_CLOSED")
        try:
            rows = self.db.execute("SELECT * FROM meta").fetchall()
            marker = self.store._db.execute("SELECT baseline FROM semantic_installation WHERE singleton=1").fetchone()
            if len(rows) != 1 or marker is None:
                raise ProtocolError("INDEX_BASELINE_MISSING")
            meta = rows[0]
            _match(meta["baseline"], r"index_[a-f0-9]{32}")
            _integer(meta["watermark"])
            if meta["binding"] != canonical(self._binding()) or meta["baseline"] != marker[0] or meta["profile"] != PROFILE_FINGERPRINT:
                raise ProtocolError("INDEX_BINDING_MISMATCH")
            # Unique watermarks plus min/max/count establish an unbroken history.
            count, low, high = self.db.execute("SELECT COUNT(*),MIN(watermark),MAX(watermark) FROM index_operations WHERE state='applied'").fetchone()
            if count != meta["watermark"] or (count and (low != 1 or high != count)):
                raise ProtocolError("INDEX_HISTORY_MISMATCH")
            invalid = self.db.execute("SELECT 1 FROM entries e LEFT JOIN index_operations o ON e.operation_id=o.operation_id WHERE o.state IS NULL OR o.state!='applied' LIMIT 1").fetchone()
            if invalid:
                raise ProtocolError("INDEX_HISTORY_MISMATCH")
            return meta
        except sqlite3.DatabaseError:
            raise ProtocolError("INDEX_METADATA_MISSING") from None

    def _vector_db(self):
        return sqlite3.connect("file:" + quote(str(Path(self.engine.db_path).absolute())) + "?mode=ro", uri=True)

    def _scan_count(self):
        try:
            with self._vector_db() as db:
                count = db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
            if count > LIMITS["maxScannedRows"]:
                raise ProtocolError("INDEX_SCAN_LIMIT")
            return count
        except sqlite3.DatabaseError:
            raise ProtocolError("INDEX_UNAVAILABLE") from None

    def _snapshot(self, native_id, body_digest, meaning):
        from ombrebrain.storage.vector_codec import decode_vector
        self.engine._assert_profile()
        try:
            with self._vector_db() as db:
                row = db.execute("SELECT embedding,meaning_embedding,content_hash FROM embeddings WHERE bucket_id=?", (native_id,)).fetchone()
            if row is None or row[2] != body_digest:
                return None
            def proof(raw):
                if not isinstance(raw, bytes) or len(raw) != 4096:
                    raise ValueError()
                vector = decode_vector(raw).tolist()
                normalize_vector(vector)
                if abs(math.fsum(value * value for value in vector) - 1) > 0.0001:
                    raise ValueError()
                return sha256(raw)
            content = {"digest": body_digest, "vectorHash": proof(row[0]), "dimensions": 1024}
            if meaning:
                meaning_proof = {"state": "indexed", "digest": sha256(meaning.encode()), "vectorHash": proof(row[1]), "dimensions": 1024}
            else:
                if row[1] is not None:
                    return None
                meaning_proof = {"state": "absent", "digest": None, "vectorHash": None, "dimensions": None}
            return {"content": content, "meaning": meaning_proof}
        except (sqlite3.DatabaseError, ValueError, TypeError, HarrierProfileError):
            return None

    async def _native(self, ref):
        row = self.store._row(ref["memoryOperationId"])
        if row is None or row["planned_id"] != ref["nativeId"]:
            raise ProtocolError("NATIVE_MISMATCH")
        status = await self.store._status(ref["memoryOperationId"])
        receipt = status["receipt"]
        if status["state"] != "applied" or receipt is None:
            raise ProtocolError("NATIVE_MISMATCH")
        if (receipt["receiptId"] != ref["bodyReceiptId"] or receipt["bodyDigest"] != ref["bodyDigest"]
                or receipt["componentVersion"] != ref["componentVersion"]):
            raise ProtocolError("NATIVE_MISMATCH")
        observed = await self.store._observe(row)
        if observed is None or observed["componentVersion"] != ref["componentVersion"]:
            raise ProtocolError("NATIVE_MISMATCH")
        bucket = await self.store.manager.get_including_archive(ref["nativeId"])
        meanings = bucket["metadata"].get("meaning") or []
        if not isinstance(meanings, list) or any(not isinstance(text, str) for text in meanings):
            raise ProtocolError("INVALID_MEANING")
        meaning = meanings[-1] if meanings else ""
        try:
            if len(meaning.encode("utf-8", errors="strict")) > 16384:
                raise ProtocolError("INVALID_MEANING")
        except UnicodeError:
            raise ProtocolError("INVALID_MEANING") from None
        return observed["body"], meaning

    def _command(self, command, digest):
        _fields(command, COMMAND_KEYS)
        if type(command["schemaVersion"]) is not int or command["schemaVersion"] != 1 or command["kind"] != "ensure-index":
            raise ProtocolError("INVALID_INDEX_COMMAND")
        identifier(command["indexOperationId"], operation=True)
        _ref({key: command[key] for key in REF_KEYS})
        for key in ("backendId", "deploymentId", "scope"):
            if command[key] != self._binding()[key]:
                raise ProtocolError("BINDING_MISMATCH")
        _match(command["indexBaselineId"], r"index_[a-f0-9]{32}")
        _integer(command["expectedIndexWatermark"])
        _integer(command["deadlineAtMs"], 1)
        if command["profileFingerprint"] != PROFILE_FINGERPRINT or type(command["maxEmbeddingCalls"]) is not int or command["maxEmbeddingCalls"] != 2:
            raise ProtocolError("INVALID_INDEX_COMMAND")
        if not isinstance(digest, str) or not HEX.fullmatch(digest) or digest != sha256(canonical(command).encode()):
            raise ProtocolError("COMMAND_DIGEST_MISMATCH")
        return json.loads(canonical(command))

    def _expected(self, baseline, watermark, profile=PROFILE_FINGERPRINT):
        meta = self._meta()
        if baseline != meta["baseline"] or watermark != meta["watermark"] or profile != PROFILE_FINGERPRINT:
            raise ProtocolError("STALE_INDEX_VIEW")
        return meta

    async def backend_status(self, scope):
        async with self.store._mutex:
            self.store._assert_open(scope)
            meta = self._meta()
            return {**self._binding(), "semanticApi": True, "profileFingerprint": PROFILE_FINGERPRINT,
                    "indexBaselineId": meta["baseline"], "indexWatermark": meta["watermark"],
                    "recordedIndexedCount": self.db.execute("SELECT COUNT(*) FROM entries").fetchone()[0],
                    "embeddingConfigured": True, "limits": dict(LIMITS)}

    async def _status(self, operation_id):
        meta = self._meta()
        row = self.db.execute("SELECT * FROM index_operations WHERE operation_id=?", (operation_id,)).fetchone()
        result = {**self._binding(), "indexOperationId": operation_id, "state": "absent", "command": None,
                  "commandDigest": None, "receipt": None, "reason": None,
                  "currentIndexBaselineId": meta["baseline"], "currentIndexWatermark": meta["watermark"],
                  "embeddingCalls": None, "usageComplete": False}
        if row is None:
            return result
        command = self._command(json.loads(row["command_json"]), row["digest"])
        result.update(state=row["state"], command=command, commandDigest=row["digest"], reason=row["error"],
                      embeddingCalls=row["calls"], usageComplete=bool(row["usage_complete"]))
        if row["state"] == "applied":
            receipt = json.loads(row["receipt_json"])
            try:
                _body, meaning = await self._native(command)
                snapshot = self._snapshot(command["nativeId"], command["bodyDigest"], meaning)
                if snapshot is None or snapshot != {"content": receipt["content"], "meaning": receipt["meaning"]}:
                    raise ProtocolError("INDEX_PROOF_MISMATCH")
                result["receipt"] = receipt
            except (ProtocolError, HarrierProfileError):
                result.update(state="unknown", reason="INDEX_PROOF_MISMATCH")
        return result

    async def index_status(self, index_operation_id, scope):
        identifier(index_operation_id, operation=True)
        async with self.store._mutex:
            self.store._assert_open(scope)
            return await self._status(index_operation_id)

    async def index_ensure(self, command, command_digest):
        command = self._command(command, command_digest)
        # Even duplicate ensure calls must respect their original deadline;
        # status is the explicit timeless observation path after expiry.
        try:
            async with _deadline(command["deadlineAtMs"]) as budget:
                async with self.store._mutex:
                    _within(budget)
                    self.store._assert_open(command["scope"])
                    row = self.db.execute("SELECT * FROM index_operations WHERE operation_id=?", (command["indexOperationId"],)).fetchone()
                    if row is not None:
                        if row["digest"] != command_digest or row["command_json"] != canonical(command):
                            raise ProtocolError("INDEX_OPERATION_CONFLICT")
                        result = await self._status(command["indexOperationId"])
                        _within(budget)
                        return result
                    self._expected(command["indexBaselineId"], command["expectedIndexWatermark"])
                    count = self._scan_count()
                    if count == LIMITS["maxScannedRows"]:
                        with self._vector_db() as db:
                            existing = db.execute("SELECT 1 FROM embeddings WHERE bucket_id=?", (command["nativeId"],)).fetchone()
                        if existing is None:
                            raise ProtocolError("INDEX_SCAN_LIMIT")
                    body, meaning = await self._native(command)
                    _within(budget)
                    self.db.execute("INSERT INTO index_operations(operation_id,command_json,digest,state) VALUES(?,?,?,'unknown')",
                                    (command["indexOperationId"], canonical(command), command_digest))
                    started_calls = self.engine._backend.request_count
                    try:
                        # Exactly one native content path and at most one native
                        # meaning path. Native storage/codec stay unchanged.
                        if not await self.engine.generate_and_store(command["nativeId"], body):
                            raise ProtocolError("EMBEDDING_FAILED")
                        _within(budget)
                        if meaning:
                            if not await self.engine.generate_and_store_meaning(command["nativeId"], meaning):
                                raise ProtocolError("EMBEDDING_FAILED")
                        else:
                            self.engine.delete_meaning_embedding(command["nativeId"])
                        await self._native(command)
                        proof = self._snapshot(command["nativeId"], command["bodyDigest"], meaning)
                        if proof is None:
                            raise ProtocolError("INDEX_PROOF_MISMATCH")
                        calls = self.engine._backend.request_count - started_calls
                        if not 0 <= calls <= command["maxEmbeddingCalls"]:
                            raise ProtocolError("EMBEDDING_BUDGET_EXCEEDED")
                        # Flush actual native vector file before publishing a
                        # separate durable receipt; crash in between stays unknown.
                        fd = os.open(self.engine.db_path, os.O_RDONLY | os.O_NOFOLLOW)
                        try:
                            os.fsync(fd)
                        finally:
                            os.close(fd)
                        _sync_directory(Path(self.engine.db_path).parent)
                        self._expected(command["indexBaselineId"], command["expectedIndexWatermark"])
                        _within(budget)
                        watermark = command["expectedIndexWatermark"] + 1
                        receipt = {**self._binding(), **{key: command[key] for key in ("indexOperationId", "memoryOperationId", "bodyReceiptId", "nativeId", "componentVersion", "bodyDigest", "profileFingerprint", "indexBaselineId")},
                                   "receiptId": "index_receipt_" + sha256((command["indexBaselineId"] + ":" + command_digest).encode()),
                                   "commandDigest": command_digest, "indexWatermark": watermark, **proof, "embeddingCalls": calls,
                                   "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
                        self.db.execute("BEGIN IMMEDIATE")
                        try:
                            self.db.execute("UPDATE meta SET watermark=? WHERE singleton=1", (watermark,))
                            self.db.execute("UPDATE index_operations SET state='applied',receipt_json=?,watermark=?,calls=?,usage_complete=1,error=NULL WHERE operation_id=?",
                                            (canonical(receipt), watermark, calls, command["indexOperationId"]))
                            self.db.execute("INSERT OR REPLACE INTO entries VALUES(?,?)", (command["nativeId"], command["indexOperationId"]))
                            self.db.execute("COMMIT")
                        except BaseException:
                            self.db.execute("ROLLBACK")
                            raise
                        outbox = self.store.manager.embedding_outbox
                        if outbox is not None:
                            outbox.complete_content(command["nativeId"], body)
                            outbox.complete_meaning(command["nativeId"], meaning)
                    except BaseException as error:
                        code = error.code if isinstance(error, (ProtocolError, HarrierProfileError)) else "CANCELLED" if isinstance(error, asyncio.CancelledError) else "INDEX_UNCONFIRMED"
                        calls = self.engine._backend.request_count - started_calls
                        self.db.execute("UPDATE index_operations SET error=?,calls=?,usage_complete=? WHERE operation_id=? AND state='unknown'",
                                        (code, calls if 0 <= calls <= 2 else None, int(0 <= calls <= 2), command["indexOperationId"]))
                        if not isinstance(error, Exception):
                            raise
                    result = await self._status(command["indexOperationId"])
                    _within(budget)
                    return result
        except TimeoutError:
            raise ProtocolError("DEADLINE_EXCEEDED") from None

    async def search_candidates(self, *, scope, query, limit, eligibleRefs, profileFingerprint,
                                expectedIndexBaselineId, expectedIndexWatermark, deadlineAtMs):
        _integer(limit, 1, 10)
        _integer(expectedIndexWatermark)
        _match(expectedIndexBaselineId, r"index_[a-f0-9]{32}")
        if not isinstance(eligibleRefs, list) or len(eligibleRefs) > 128:
            raise ProtocolError("INVALID_SEMANTIC_INPUT")
        previous = ""
        for ref in eligibleRefs:
            _ref(ref)
            if ref["nativeId"] <= previous:
                raise ProtocolError("INVALID_SEMANTIC_INPUT")
            previous = ref["nativeId"]
        try:
            query_bytes = query.encode("utf-8", errors="strict") if isinstance(query, str) else b""
        except UnicodeError:
            raise ProtocolError("INVALID_UNICODE") from None
        if not query_bytes or len(query_bytes) > 8192 or not query.strip():
            raise ProtocolError("INVALID_SEMANTIC_INPUT")
        try:
            async with _deadline(deadlineAtMs) as budget:
                async with self.store._mutex:
                    _within(budget)
                    self.store._assert_open(scope)
                    meta = self._expected(expectedIndexBaselineId, expectedIndexWatermark, profileFingerprint)
                    self._scan_count()
                    proofs = {}
                    for ref in eligibleRefs:
                        await self._native(ref)
                        entry = self.db.execute("SELECT operation_id FROM entries WHERE native_id=?", (ref["nativeId"],)).fetchone()
                        status = await self._status(entry[0]) if entry else None
                        if status and status["state"] == "applied":
                            receipt = status["receipt"]
                            if all(receipt[key] == ref[key] for key in REF_KEYS):
                                proofs[ref["nativeId"]] = receipt
                    result = {**self._binding(), "state": "ok", "profileFingerprint": PROFILE_FINGERPRINT,
                              "indexBaselineId": meta["baseline"], "indexWatermark": meta["watermark"],
                              "queryDigest": sha256(query_bytes), "embeddingCalls": 0, "usageComplete": True,
                              "coverage": {"eligibleCount": len(eligibleRefs), "indexedCount": len(proofs), "missingCount": len(eligibleRefs) - len(proofs)}, "matches": []}
                    if len(proofs) != len(eligibleRefs):
                        result["state"] = "index_required"
                        _within(budget)
                        return result
                    if not proofs:
                        _within(budget)
                        return result
                    _within(budget)
                    started_calls = self.engine._backend.request_count
                    try:
                        ranked = await self.engine.search_similar_strict(query, top_k=limit, allowed_bucket_ids=set(proofs))
                    except (HarrierProfileError, RuntimeError, ValueError):
                        raise ProtocolError("SEMANTIC_QUERY_FAILED") from None
                    self._expected(expectedIndexBaselineId, expectedIndexWatermark, profileFingerprint)
                    result["embeddingCalls"] = self.engine._backend.request_count - started_calls
                    if result["embeddingCalls"] not in (0, 1):
                        raise ProtocolError("EMBEDDING_BUDGET_EXCEEDED")
                    for native_id, score in ranked:
                        receipt = proofs.get(native_id)
                        if receipt is None or not math.isfinite(score) or not -1.000001 <= score <= 1.000001:
                            raise ProtocolError("INVALID_SEARCH_RESULT")
                        # Native source and both vector proofs must still agree
                        # after the model await; no stale body/meaning release.
                        status = await self._status(receipt["indexOperationId"])
                        if status["state"] != "applied" or status["receipt"] != receipt:
                            raise ProtocolError("INDEX_PROOF_MISMATCH")
                        result["matches"].append({key: receipt[key] for key in ("memoryOperationId", "nativeId", "componentVersion", "bodyDigest", "indexWatermark")}
                                                 | {"indexReceiptId": receipt["receiptId"], "score": float(score)})
                    _within(budget)
                    return result
        except TimeoutError:
            raise ProtocolError("DEADLINE_EXCEEDED") from None
