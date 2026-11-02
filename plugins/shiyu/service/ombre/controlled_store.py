"""A metadata receipt journal around pinned native BucketManager.create/get.

No body database, native state machine, model loop, or write retry is introduced.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import uuid

from protocol import ProtocolError, canonical, identifier, sha256, validate

SOURCE_TOOL = "shiyu_strict_create"
_planned_id = ContextVar("shiyu_planned_native_id", default=None)


def strict_manager_class(upstream_class):
    class StrictBucketManager(upstream_class):
        @asynccontextmanager
        async def _bucket_turn(self, bucket_id):
            expected = _planned_id.get()
            if expected is not None and bucket_id != expected:
                raise ProtocolError("NATIVE_ID_COLLISION")
            async with super()._bucket_turn(bucket_id):
                yield
    return StrictBucketManager


def _sync_directory(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class ControlledStore:
    def __init__(self, root, *, backend_id, scope, deployment_id, manager_factory, embedding_enabled=False):
        self.backend_id = identifier(backend_id)
        self.scope = identifier(scope)
        self.deployment_id = identifier(deployment_id)
        self.root = Path(root).absolute()
        if self.root.is_symlink():
            raise ProtocolError("UNSAFE_VAULT_ROOT")
        missing = []
        cursor = self.root
        while not cursor.exists():
            missing.append(cursor)
            cursor = cursor.parent
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for created in missing:
            _sync_directory(created)
            _sync_directory(created.parent)
        self.root = self.root.resolve()
        self.meta_dir = self.root / ".shiyu"
        self.meta_dir.mkdir(mode=0o700, exist_ok=True)
        if self.meta_dir.is_symlink():
            raise ProtocolError("UNSAFE_VAULT_ROOT")
        self._lease = os.open(self.meta_dir / "service.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self._db = None
        self._closed = False
        self._mutex = asyncio.Lock()
        self.embedding_enabled = embedding_enabled
        self.manager = None
        try:
            try:
                fcntl.flock(self._lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ProtocolError("VAULT_ALREADY_OPEN") from exc
            db_path = self.meta_dir / "operations.sqlite3"
            if db_path.is_symlink():
                raise ProtocolError("UNSAFE_JOURNAL")
            existed = db_path.exists()
            if not existed and (any(p.name != ".shiyu" for p in self.root.iterdir()) or any(p.name != "service.lock" for p in self.meta_dir.iterdir())):
                raise ProtocolError("UNBOUND_EXISTING_VAULT")
            self._db = sqlite3.connect(db_path, isolation_level=None)
            self._db.row_factory = sqlite3.Row
            if existed:
                try:
                    row = self._db.execute("SELECT binding FROM installation WHERE singleton=1").fetchone()
                except sqlite3.DatabaseError as exc:
                    raise ProtocolError("JOURNAL_METADATA_MISSING") from exc
                if row is None or row[0] != canonical(self._binding()):
                    raise ProtocolError("JOURNAL_BINDING_MISMATCH")
            else:
                self._db.executescript("""
                    PRAGMA journal_mode=WAL;
                    PRAGMA synchronous=FULL;
                    BEGIN IMMEDIATE;
                    CREATE TABLE installation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),binding TEXT NOT NULL);
                    CREATE TABLE operations(operation_id TEXT PRIMARY KEY,command_json TEXT NOT NULL,digest TEXT NOT NULL,
                        planned_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('unknown','applied','rejected')),
                        receipt_json TEXT,error TEXT);
                    COMMIT;
                """)
                self._db.execute("INSERT INTO installation VALUES(1,?)", (canonical(self._binding()),))
                _sync_directory(self.meta_dir)
                _sync_directory(self.root)
            self._db.execute("PRAGMA synchronous=FULL")
            self.manager = manager_factory(self.root / "buckets")
        except BaseException:
            self._dispose()
            raise

    def _binding(self):
        return {"schemaVersion": 1, "backendId": self.backend_id, "deploymentId": self.deployment_id, "scope": self.scope}

    def _assert_open(self, scope):
        if self._closed or self._db is None:
            raise ProtocolError("SERVICE_CLOSED")
        if scope != self.scope:
            raise ProtocolError("BINDING_MISMATCH")

    def _row(self, operation_id):
        return self._db.execute("SELECT * FROM operations WHERE operation_id=?", (operation_id,)).fetchone()

    async def initialize(self):
        """Only reconcile durable intents; never issue create or embedding here."""
        async with self._mutex:
            self._assert_open(self.scope)
            rows = self._db.execute("SELECT * FROM operations WHERE state='unknown'").fetchall()
            for row in rows:
                observed = await self._observe(row, durable=True)
                if observed is not None:
                    self._confirm(row, observed, reconciled=True)

    async def _observe(self, row, *, durable=False):
        import frontmatter
        command = json.loads(row["command_json"])
        native_id = row["planned_id"]
        try:
            # Exact native ID only, never search/touch or a missing-ID fallback.
            bucket = await self.manager.get_including_archive(native_id)
            if not bucket or bucket.get("id") != native_id:
                return None
            meta = bucket.get("metadata", {})
            if meta.get("id") != native_id or meta.get("source_tool") != SOURCE_TOOL or meta.get("grow_batch_id") != row["digest"]:
                return None
            if meta.get("type") != "dynamic" or any(meta.get(k) for k in ("deleted_at", "tombstone", "deleted", "erased_at", "provenance", "pinned", "protected")):
                return None
            path = Path(bucket["path"])
            if path.is_symlink() or not path.resolve().is_relative_to((self.root / "buckets" / "dynamic").resolve()):
                return None
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                with os.fdopen(fd, "rb", closefd=False) as handle:
                    raw = handle.read(65537)
                if len(raw) > 65536:
                    return None
                post = frontmatter.loads(raw.decode("utf-8", errors="strict"))
                body = bucket.get("content")
                if post.content != body or dict(post.metadata) != meta:
                    return None
                data = body.encode("utf-8", errors="strict")
                if len(data) != command["bodyBytes"] or sha256(data) != command["bodyDigest"]:
                    return None
                if durable:
                    os.fsync(fd)
            finally:
                os.close(fd)
            if durable:
                _sync_directory(path.parent)
                _sync_directory(path.parent.parent)
                _sync_directory(self.root / "buckets")
                _sync_directory(self.root)
            return {"body": body, "bodyDigest": command["bodyDigest"], "componentVersion": "sha256:" + sha256(raw)}
        except (OSError, UnicodeError, ValueError, TypeError, KeyError):
            return None

    def _confirm(self, row, observed, *, reconciled):
        command = json.loads(row["command_json"])
        receipt = {**self._binding(), "receiptId": "receipt_" + sha256((self.deployment_id + ":" + row["digest"]).encode()),
                   "operationId": command["operationId"], "commandDigest": row["digest"], "nativeId": row["planned_id"],
                   "bodyDigest": command["bodyDigest"], "bodyBytes": command["bodyBytes"], "sourceRefs": command["sourceRefs"],
                   "componentVersion": observed["componentVersion"], "outcome": "applied", "bodyDurable": True,
                   "indexState": "unknown" if self.embedding_enabled else "disabled",
                   "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "reconciled": reconciled}
        self._db.execute("UPDATE operations SET state='applied',receipt_json=?,error=NULL WHERE operation_id=? AND state='unknown'",
                         (canonical(receipt), row["operation_id"]))

    async def create(self, command, command_digest, body):
        import frontmatter
        async with self._mutex:
            self._assert_open(self.scope)
            command = validate(command, command_digest, body, backend_id=self.backend_id, scope=self.scope)
            if "\r" in body or self.manager._sanitize_text(body) != body or frontmatter.loads(frontmatter.dumps(frontmatter.Post(body))).content != body:
                raise ProtocolError("NON_CANONICAL_BODY")
            row = self._row(command["operationId"])
            if row is not None:
                if row["digest"] != command_digest or row["command_json"] != canonical(command):
                    raise ProtocolError("OPERATION_ID_CONFLICT")
                return await self._status(command["operationId"])
            planned_id = "shiyu_" + uuid.uuid4().hex
            self._db.execute("INSERT INTO operations VALUES(?,?,?,?, 'unknown',NULL,NULL)",
                             (command["operationId"], canonical(command), command_digest, planned_id))
            row = self._row(command["operationId"])
            # No side effect has been dispatched here. An existing exact ID is a rejection.
            if self.manager._find_bucket_file(planned_id):
                self._db.execute("UPDATE operations SET state='rejected',error='NATIVE_ID_COLLISION' WHERE operation_id=?", (command["operationId"],))
                return await self._status(command["operationId"])
            token = _planned_id.set(planned_id)
            try:
                native_id = await self.manager.create(body, bucket_id_override=planned_id, source_tool=SOURCE_TOOL,
                    grow_batch_id=command_digest, bucket_type="dynamic", domain=["shiyu"], title="", tags=[],
                    test_data=False, event_actor="system")
                if native_id != planned_id:
                    raise ProtocolError("NATIVE_ID_MISMATCH")
                observed = await self._observe(row, durable=True)
                if observed is None:
                    raise ProtocolError("NATIVE_MISMATCH")
                self._confirm(row, observed, reconciled=False)
            except asyncio.CancelledError:
                self._db.execute("UPDATE operations SET error='CANCELLED' WHERE operation_id=? AND state='unknown'", (command["operationId"],))
                raise
            except Exception as exc:
                code = exc.code if isinstance(exc, ProtocolError) else "NATIVE_CREATE_UNCONFIRMED"
                self._db.execute("UPDATE operations SET error=? WHERE operation_id=? AND state='unknown'", (code, command["operationId"]))
            finally:
                _planned_id.reset(token)
            return await self._status(command["operationId"])

    async def _status(self, operation_id):
        row = self._row(operation_id)
        base = {**self._binding(), "operationId": operation_id, "state": "absent", "command": None,
                "commandDigest": None, "plannedNativeId": None, "nativeId": None, "receipt": None, "reason": None}
        if row is None:
            return base
        base.update(state=row["state"], command=json.loads(row["command_json"]), commandDigest=row["digest"], plannedNativeId=row["planned_id"], reason=row["error"])
        if row["state"] == "applied":
            receipt = json.loads(row["receipt_json"])
            observed = await self._observe(row)
            if observed is None or observed["componentVersion"] != receipt["componentVersion"]:
                base.update(state="unknown", reason="NATIVE_MISMATCH")
            else:
                base.update(nativeId=row["planned_id"], receipt=receipt)
        return base

    async def operation_status(self, operation_id, scope):
        async with self._mutex:
            self._assert_open(scope)
            return await self._status(identifier(operation_id, operation=True))

    async def get(self, native_id, scope):
        async with self._mutex:
            self._assert_open(scope)
            identifier(native_id)
            row = self._db.execute("SELECT * FROM operations WHERE planned_id=?", (native_id,)).fetchone()
            result = {**self._binding(), "state": "not_found", "nativeId": native_id, "command": None,
                      "commandDigest": None, "receipt": None, "body": None, "bodyDigest": None,
                      "componentVersion": None, "reason": None}
            if row is None:
                return result
            result.update(command=json.loads(row["command_json"]), commandDigest=row["digest"])
            status = await self._status(row["operation_id"])
            observed = await self._observe(row) if status["state"] == "applied" else None
            if observed is None or observed["componentVersion"] != status["receipt"]["componentVersion"]:
                result.update(state="mismatch", reason="NATIVE_MISMATCH")
            else:
                result.update(state="found", receipt=status["receipt"], **observed)
            return result

    def _dispose(self):
        self._closed = True
        if self._db is not None:
            self._db.close()
            self._db = None
        if self._lease is not None:
            os.close(self._lease)
            self._lease = None

    async def close(self):
        async with self._mutex:
            self._dispose()
