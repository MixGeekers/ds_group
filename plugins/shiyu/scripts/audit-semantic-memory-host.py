"""Phase 3F scoped, read-only host audit. No product imports, RPC, model or UI.

--init-plan reads ONLY the published 3E artifact and writes an ignored plan.
Stages read exact approved SQLite/files and write one exclusive ignored snapshot.
Nothing is automatically published; existing plans/stages are never overwritten.
Use the existing product Python environment (frontmatter and zstandard are pinned).
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
from urllib.parse import quote

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE / "artifacts/memory-host-validation.json"
PLAN = BASE / ".local/phase3f-host-plan.json"
STAGES = ("baseline", "reload", "save", "index", "search", "load-only", "withdraw", "post-withdraw-load", "refresh")
MAX_JSON = 8 * 1024 * 1024
MAX_ROWS = 2048


class AuditError(Exception):
    """Fixed error codes only: never expose raw database/native text in errors."""


def require(condition, code):
    if not condition:
        raise AuditError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def regular_path(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, "UNSAFE_PATH")
    require(stat.S_ISREG(path.lstat().st_mode), "NOT_REGULAR")
    return path


def stable_read(path, limit=MAX_JSON):
    path = regular_path(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, "FILE_BOUND")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        after = os.fstat(descriptor)
        require(len(raw) <= limit and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "FILE_CHANGED")
        return raw, {"bytes": len(raw), "sha256": sha(raw), "mtimeNs": str(after.st_mtime_ns)}
    finally:
        os.close(descriptor)


def json_file(path):
    return json.loads(stable_read(path)[0])


def exclusive_json(path, value):
    # No overwrite or automatic publication. Callers provide only .local paths.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


# Explicit metadata allowlist. Unknown future fields are omitted; no record_json
# is ever dumped wholesale. content/meaning are handled as digest-only objects.
SAFE_KEYS = set("""
id schemaVersion schema_version version localVersion revision stateVersion state_version baselineId baseline_id
started_at commit_seq schema_hash publisher_hash manifestHash publishedAt publisherId manifest domains memory
relationship emotion cognition personality ability status reason capabilities profileFingerprint
backendId backend_id deploymentId deployment_id scope operationId operation_id memoryOperationId indexOperationId
index_operation_id requestId request_id sourceId source_id sourceRefs revision sourceRevision audienceVersion
conversationId conversation_id bindingId binding_id topicId topic_id sourceVersion contextVersion syncedContextVersion
routingRevision syncedRoutingRevision conversationGeneration sessionEpoch session_epoch epoch sessionId session_id
businessId role key connectionId platformConversationId kind archived token nativeBinding contextReceipt native nativeId
messageId messageHash userMessageSeq confirmedAt durability contextTokenId expectedSessionId inputId inputHash input_hash
captureId viewId expiresAt createdAt updatedAt registeredAt at retiredSessions conversationIds source readToken
bodyDigest bodyBytes command commandDigest command_digest digest proof_hash intent_hash commandRef targetRef bytes
receipt receiptId receipt_id receiptRef bodyReceiptId lastReceiptId publishedReceiptId receipt_json componentVersion
effectId effect_id mandateId reservationId mandateVersion authEpoch auth_epoch policyVersion state frozen
installationGeneration hostEpoch fencingToken fence execution embeddingUsage maxEmbeddingCalls embeddingCalls calls
tokens effects complete usageComplete usage_complete observed amount limits overrun outcome bodyDurable indexState
indexBaselineId currentIndexBaselineId indexWatermark currentIndexWatermark expectedIndexWatermark deadlineAtMs
observation reconciliation reconciled observedAt blocked blockedAtWatermark deletionBaselineId tombstoneWatermark
authorizationEpoch saveMandateVersion consent basisRef grantedAt withdrawnAt withdrawal_id reasonCode
publishedReceiptId sourceRevision terminal uncertainty resultHash evidenceRefs verificationRef
policy_hash catalog_revision catalogHash fromRevision toRevision fromPolicyHash toPolicyHash migratedAt migrationId
authorityId deletionAuthorityId policyAuthorityId policyVersion enabled watermark baseline profile binding
singleton planned_id plannedNativeId command_json state receipt_json indexed_count count count_kind
queryDigest matches score coverage eligibleCount indexedCount missingCount indexReceiptId
content meaning vectorHash dimensions receipt_ref source_version ref_key metadataVersion goalId goalRef
permissionEpoch tombstone_watermark deletion_baseline_id installation_generation backend_version
input origin mandateRef terminal uncertainty verification taskId backendReceiptRef authorization
sourceRefs dependencyRefs source_state approvedBy publishedBy history_hash barrier_hash local_version
""".split())
SAFE_KEYS.discard("evidenceRefs")  # Task evidence labels are free text; not needed by this audit.
OBJECT_FIELDS = set("""input origin mandateRef terminal uncertainty verification command receipt
observation readToken source native nativeBinding contextReceipt token execution embeddingUsage
consent manifest domains memory relationship emotion cognition personality ability authorization""".split())
UNAVAILABLE_CODES = {"not_connected", "not_implemented", "source_unavailable", "verification_pending", "incompatible_version"}


def redacted(value):
    return {"redactedSha256": sha(canonical(value).encode())}


def metadata(value, depth=0):
    require(depth <= 24, "METADATA_DEPTH")
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key not in SAFE_KEYS:
                continue
            if key in OBJECT_FIELDS and item is not None and not isinstance(item, dict):
                result[key] = redacted(item)
                continue
            if key == "reason" and item is not None and not (isinstance(item, str) and item in UNAVAILABLE_CODES):
                result[key] = redacted(item)
                continue
            if key in ("content", "meaning"):
                # In index receipts these names denote digest metadata, never text/vectors.
                if isinstance(item, dict):
                    result[key] = metadata({k: v for k, v in item.items() if k in ("state", "digest", "vectorHash", "dimensions")}, depth + 1)
                continue
            result[key] = metadata(item, depth + 1)
        return result
    if isinstance(value, list):
        require(len(value) <= MAX_ROWS, "METADATA_ROWS")
        # Metadata sets contain structured references or IDs; numeric vectors
        # and arbitrary primitive sequences are never part of an audit record.
        if any(isinstance(item, (int, float, bool, list)) for item in value):
            return redacted(value)
        return [metadata(item, depth + 1) for item in value]
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        require(value == value and abs(value) != float("inf"), "METADATA_NUMBER")
        return value
    require(isinstance(value, str), "METADATA_TYPE")
    # Strings are IDs, codes, hashes or canonical times, never arbitrary prose.
    if len(value) <= 500 and re.fullmatch(r"[A-Za-z0-9:._/+\-\[\],\"]*", value):
        return value
    return {"redactedSha256": sha(value.encode("utf-8"))}


def safe_record(raw):
    require(isinstance(raw, str) and len(raw.encode()) <= MAX_JSON, "RECORD_BOUND")
    return {"recordSha256": sha(raw.encode()), "metadata": metadata(json.loads(raw))}


def read_db(path, callback):
    regular_path(path)
    db = sqlite3.connect("file:" + quote(str(path)) + "?mode=ro", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        require(db.execute("PRAGMA query_only").fetchone()[0] == 1, "QUERY_ONLY_REQUIRED")
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION,
                   sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_RECURSIVE}
        db.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
        deadline = time.monotonic() + 10
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        db.execute("BEGIN")
        return callback(db)
    finally:
        db.rollback()
        db.close()


def scope_from_source(artifact):
    scope = dict(artifact["scope"])
    require(len(scope["ownedNativeSessions"]) == 7 and len(set(scope["exactSessionRoots"])) == 3, "SOURCE_SCOPE")
    scope["deploymentId"] = artifact["result"]["deploymentId"]
    scope["backendId"] = artifact["checkpoints"]["post-refresh"]["backend"]["configuration"]["backendId"]
    scope["scope"] = "local-owner"
    scope["previousMemoryOperationId"] = artifact["result"]["operationId"]
    return scope


def make_plan(artifact, source_hash):
    return {"schemaVersion": 1, "phase": "3F", "status": "plan-only-no-host-read", "createdAt": now(),
        "sourceArtifact": "artifacts/memory-host-validation.json", "sourceArtifactSha256": source_hash,
        "scope": scope_from_source(artifact), "stages": list(STAGES),
        "limits": {"newSyntheticMemories": 1, "totalNativeMarkdown": 2, "compressedSessionBytes": 20971520,
                   "decodedSessionBytes": 67108864, "nativeEventRows": 100000,
                   "loadOnlyCommands": 2, "hostEmbeddingRequests": 6, "generationRequests": 0},
        "readPolicy": {"sqlite": "URI mode=ro; query_only; authorizer; BEGIN/ROLLBACK",
                       "native": "original seven plus runtime-and-control-authorized replyer files in original roots",
                       "body": "hash in memory only; no body/query/vector/native data persisted",
                       "writes": "exclusive .local stage snapshots only; no artifact publication"},
        "proofPolicy": {"generation": "compare every native event prefix and newly added event types; no global network claim",
                        "loadOnly": "exact confirmed user/message hash; report all other new types; require zero request/assistant/turn/step/titleLLM/compaction",
                        "crossDatabase": "separate read transactions; no distributed atomic snapshot claim",
                        "search": "query/results may be transient; DB snapshot cannot prove a search invocation or ranking"},
        "snapshotSchema": {"schemaVersion": 1, "fields": ["stage", "capturedAt", "scopeSha256", "control", "runtime", "backend", "native", "comparisons", "limitations"]}}


def control_snapshot(scope):
    def query(db):
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        def rows(table, clause="", args=(), columns="*"):
            if table not in tables:
                return None
            values = db.execute(f'SELECT {columns} FROM "{table}" {clause}', args).fetchmany(MAX_ROWS + 1)
            require(len(values) <= MAX_ROWS, "CONTROL_ROWS")
            return [dict(row) for row in values]
        def record_rows(table, clause="", args=(), column="record_json"):
            raw = rows(table, clause, args, column)
            return None if raw is None else [safe_record(row[column]) for row in raw]
        cid, bid = scope["conversationId"], scope["bindingId"]
        memory_meta = rows("shiyu_local_memory_meta", "WHERE id=1")
        require(memory_meta is not None and len(memory_meta) == 1 and memory_meta[0]["backend_id"] == scope["backendId"]
                and memory_meta[0]["deployment_id"] == scope["deploymentId"], "MEMORY_DEPLOYMENT")
        local = rows("shiyu_local_memory_operations", "WHERE conversation_id=? ORDER BY operation_id", (cid,)) or []
        require(len(local) <= 2, "MEMORY_SCOPE_LIMIT")
        for row in local:
            command = json.loads(row["record_json"])["command"]
            require(command["backendId"] == scope["backendId"] and command["scope"] == "local-owner", "MEMORY_BINDING")
        mids = [r["operation_id"] for r in local]
        source_ids = [r["source_id"] for r in local]
        def selected(table, column, ids):
            if not ids:
                return [] if table in tables else None
            return record_rows(table, f'WHERE "{column}" IN ({",".join("?" for _ in ids)}) ORDER BY "{column}"', ids)
        bindings = record_rows("shiyu_reply_bindings", "WHERE id=? AND conversation_id=? AND scope='local-owner'", (bid, cid))
        require(bindings is not None and len(bindings) == 1, "CONVERSATION_BINDING")
        index_rows = []
        if "shiyu_memory_index_operations" in tables:
            for mid in mids:
                index_rows += rows("shiyu_memory_index_operations", "WHERE json_extract(record_json,'$.command.memoryOperationId')=? ORDER BY index_operation_id", (mid,))
        for row in index_rows:
            command = json.loads(row["record_json"])["command"]
            require(all(command[k] == scope[k] for k in ("backendId", "deploymentId", "scope")), "INDEX_BINDING")
        indices = [r["index_operation_id"] for r in index_rows]
        reply_ops = record_rows("shiyu_local_reply_inputs", "WHERE conversation_id=? ORDER BY operation_id", (cid,)) or []
        for row in reply_ops:
            require(row["metadata"]["bindingId"] == bid and row["metadata"]["scope"] == "local-owner", "REPLY_BINDING")
        exposures = record_rows("shiyu_local_reply_memory_exposures", "WHERE binding_id=? ORDER BY operation_id,source_id", (bid,))
        for row in exposures or []:
            source = row["metadata"]["source"]
            require(source["operationId"] in mids and source["conversationId"] == cid, "EXPOSURE_SCOPE")
            require(all(source["readToken"][k] == scope[k] for k in ("backendId", "deploymentId")), "EXPOSURE_BACKEND")
        withdrawals = record_rows("shiyu_local_reply_memory_withdrawals",
            "WHERE EXISTS(SELECT 1 FROM json_each(record_json,'$.retiredSessions') WHERE json_extract(value,'$.bindingId')=?)", (bid,))
        for row in withdrawals or []:
            value = row["metadata"]
            value["retiredSessions"] = [r for r in value.get("retiredSessions", []) if r.get("bindingId") == bid]
            value["conversationIds"] = [v for v in value.get("conversationIds", []) if v == cid]
        pub = record_rows("shiyu_state_publication_head", "WHERE id=1")
        for row in pub or []:
            memory = row["metadata"]["manifest"]["domains"]["memory"]
            if memory.get("status") == "available":
                require(all(memory[k] == scope[k] for k in ("backendId", "deploymentId")), "PUBLICATION_BINDING")
        records = {
            "watermark": metadata(rows("shiyu_commit_watermark", "WHERE id=1")),
            "conversation": record_rows("shiyu_conversations", "WHERE id=?", (cid,)), "binding": bindings,
            "nativeSessions": metadata(rows("shiyu_reply_sessions", "WHERE binding_id=? AND scope='local-owner' ORDER BY session_id", (bid,))),
            "replyOperations": reply_ops, "exposures": exposures, "contextWithdrawals": withdrawals,
            "publication": pub, "publicationMeta": metadata(rows("shiyu_state_publication_meta", "WHERE id=1")),
            "memoryLocal": [safe_record(r["record_json"]) for r in local],
            "memoryLocalMeta": metadata(memory_meta),
            "memoryLedgerMeta": metadata(rows("shiyu_memory_meta", "WHERE id=1")),
            "memorySources": selected("shiyu_local_memory_sources", "source_id", source_ids),
            "memoryOperations": selected("shiyu_memory_operations", "operation_id", mids),
            "memoryReceipts": selected("shiyu_memory_receipts", "operation_id", mids),
            "memoryPublications": selected("shiyu_memory_publications", "operation_id", mids),
            "indexMeta": metadata(rows("shiyu_memory_index_meta", "WHERE backend_id=? AND deployment_id=?", (scope["backendId"], scope["deploymentId"]))),
            "indexOperations": [safe_record(r["record_json"]) for r in index_rows],
            "indexReceipts": selected("shiyu_memory_index_receipts", "index_operation_id", indices),
            "authority": {"meta": metadata(rows("shiyu_policy_meta", "WHERE id=1")), "catalog": metadata(rows("shiyu_policy_catalog_state", "WHERE id=1"))},
            "tasks": record_rows("shiyu_task_record", "WHERE id IN (?,?) ORDER BY id", scope["taskIds"], "value")}
        # Source IDs are metadata, not bodies. Keep the exact ID set for backend scope.
        return {"sqliteMode": "ro", "queryOnly": True, "sqliteVersion": sqlite3.sqlite_version,
                "records": records, "metadataSha256": sha(canonical(records).encode()), "memoryOperationIds": mids}
    return read_db(Path(scope["controlDb"]), query)


def runtime_snapshot(scope, control):
    value = json_file(scope["runtimeState"])
    bindings = []
    for row in value.get("bindings", []):
        allowed = {r["metadata"].get("businessId") for r in control["records"]["replyOperations"]}
        allowed.add(control["records"]["binding"][0]["metadata"].get("businessId"))
        if row.get("role") == "replyer" and row.get("scope") == "local-owner" and row.get("businessId") in allowed:
            bindings.append(metadata(row))
    return {"paused": value.get("paused"), "bindings": bindings}


def native_event_metadata(raw, limits, synthetic_body=None):
    import zstandard
    with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw), read_across_frames=True) as reader:
        decoded = reader.read(limits["decodedSessionBytes"] + 1)
    require(len(decoded) <= limits["decodedSessionBytes"], "NATIVE_DECODE_BOUND")
    lines = decoded.splitlines()
    require(0 < len(lines) <= limits["nativeEventRows"] + 1, "NATIVE_ROWS")
    events, counts = [], Counter()
    for index, line in enumerate(lines):
        require(len(line) <= MAX_JSON, "NATIVE_LINE_BOUND")
        value = json.loads(line)
        require(isinstance(value, dict), "NATIVE_ROW")
        if index == 0:
            require("seq" not in value, "NATIVE_HEADER")
            continue
        seq, kind = value.get("seq"), value.get("type")
        require(type(seq) is int and seq == len(events), "NATIVE_SEQUENCE")
        require(isinstance(kind, str) and re.fullmatch(r"[A-Za-z0-9_/.-]{1,120}", kind), "NATIVE_EVENT_TYPE")
        item = {"seq": seq, "type": kind, "eventHash": sha(canonical(value).encode())}
        data = value.get("data")
        message = data if kind == "user/message" else data.get("message") if kind == "assistant/message" and isinstance(data, dict) else None
        if isinstance(message, dict):
            mid = message.get("id")
            require(mid is None or isinstance(mid, str) and re.fullmatch(r"[A-Za-z0-9:._/-]{1,200}", mid), "NATIVE_MESSAGE_ID")
            item.update(messageId=mid, messageIdentityComplete=mid is not None, messageHash=sha(canonical(message).encode()))
            parts = message.get("content") if isinstance(message.get("content"), list) else []
            item["knownSyntheticBodyPresent"] = None if synthetic_body is None else any(
                isinstance(part, dict) and isinstance(part.get("text"), str) and synthetic_body in part["text"]
                for part in parts)
        events.append(item)
        counts[kind] += 1
    return {"headerHash": sha(lines[0]), "events": events, "eventCounts": dict(sorted(counts.items())),
            "decodedRows": len(lines), "decodedBytes": len(decoded), "messageBodyIncluded": False}


def native_snapshot(scope, control, runtime, limits, previous=None, synthetic_body=None):
    roots = {Path(root) for root in scope["exactSessionRoots"]}
    for root in roots:
        require(root.resolve(strict=True) == root and root.is_dir(), "SESSION_ROOT")
    known = {item["sessionId"]: dict(item) for item in scope["ownedNativeSessions"]}
    # Previously admitted file paths remain in scope after epoch retirement.
    records = control["records"]
    control_rows = records["nativeSessions"] or []
    current = records["binding"][0]["metadata"]
    for row in (previous or {}).get("native", {}).get("files", []):
        if row["sessionId"] not in known:
            require(any(binding["session_id"] == row["sessionId"] for binding in control_rows), "RETIRED_SESSION_AUTHORITY")
            known[row["sessionId"]] = {"sessionId": row["sessionId"], "file": row["file"]}
    for binding in runtime["bindings"]:
        sid = binding.get("sessionId")
        if not sid or sid in known:
            continue
        if binding.get("businessId") != current.get("businessId") or sid != current.get("sessionId"):
            continue
        require(isinstance(sid, str) and re.fullmatch(r"shiyu-replyer-[A-Za-z0-9-]{1,100}", sid), "NEW_SESSION_ID")
        require(any(row["session_id"] == sid and row["epoch"] == current["sessionEpoch"] for row in control_rows), "NEW_SESSION_AUTHORITY")
        found = [root / sid / "session.v4.jsonl.zstd" for root in roots if (root / sid / "session.v4.jsonl.zstd").exists()]
        require(len(found) == 1, "NEW_SESSION_LOCATION")
        known[sid] = {"sessionId": sid, "file": str(found[0])}
    require(len(known) <= 9, "SESSION_SCOPE_BOUND")
    files = []
    for sid, item in sorted(known.items()):
        path = Path(item["file"])
        require(path.parent.parent in roots and path.parent.name == sid and path.name == "session.v4.jsonl.zstd", "SESSION_PATH")
        raw, fingerprint = stable_read(path, limits["compressedSessionBytes"])
        files.append({**item, **fingerprint, **native_event_metadata(raw, limits, synthetic_body)})
    inventory = [{"root": str(root), "sessionIds": sorted(p.name for p in root.iterdir() if p.is_dir() and not p.is_symlink() and p.name.startswith("shiyu-"))} for root in sorted(roots)]
    return {"files": files, "inventory": inventory, "unapprovedFilesRead": False}


def backend_snapshot(scope, memory_ids, limits):
    vault = Path(scope["ownedMemoryVault"])
    require(vault.resolve(strict=True) == vault and vault.is_dir(), "VAULT_PATH")
    def journal(db):
        install = dict(db.execute("SELECT * FROM installation").fetchone())
        # installation.binding is the canonical JSON of exact backend/deployment/scope.
        binding = json.loads(install["binding"])
        require(all(binding[k] == scope[k] for k in ("backendId", "deploymentId", "scope")), "BACKEND_BINDING")
        all_ops = db.execute("SELECT * FROM operations ORDER BY operation_id").fetchmany(3)
        require(len(all_ops) <= 2, "VAULT_OPERATION_BOUND")
        result = []
        for row in all_ops:
            require(row["operation_id"] in memory_ids, "BACKEND_OPERATION_SCOPE")
            result.append({"operationId": row["operation_id"], "state": row["state"],
                "command": safe_record(row["command_json"]),
                "receipt": safe_record(row["receipt_json"]) if row["receipt_json"] else None})
        marker_exists = db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='semantic_installation'").fetchone()
        marker = [metadata(dict(row)) for row in db.execute("SELECT * FROM semantic_installation WHERE singleton=1")] if marker_exists else None
        return {"installation": metadata(binding), "operations": result, "semanticInstallation": marker}
    result = {"journal": read_db(vault / ".shiyu/operations.sqlite3", journal)}
    semantic = vault / ".shiyu/semantic.sqlite3"
    result["semanticPresent"] = semantic.exists()
    if semantic.exists():
        def indices(db):
            metas = []
            for row in db.execute("SELECT * FROM meta"):
                binding = json.loads(row["binding"])
                require(all(binding[k] == scope[k] for k in ("backendId", "deploymentId", "scope")), "SEMANTIC_BINDING")
                metas.append(metadata({**dict(row), "binding": binding}))
            require(len(metas) == 1, "SEMANTIC_META")
            values = db.execute("SELECT * FROM index_operations ORDER BY operation_id").fetchmany(MAX_ROWS + 1)
            require(len(values) <= MAX_ROWS, "INDEX_ROWS")
            selected = []
            for row in values:
                command = json.loads(row["command_json"])
                require(command["memoryOperationId"] in memory_ids and all(command[k] == scope[k] for k in ("backendId", "deploymentId", "scope")), "BACKEND_INDEX_SCOPE")
                selected.append({"indexOperationId": row["operation_id"], "state": row["state"], "watermark": row["watermark"],
                    "calls": row["calls"], "usageComplete": bool(row["usage_complete"]), "command": safe_record(row["command_json"]),
                    "receipt": safe_record(row["receipt_json"]) if row["receipt_json"] else None})
            return {"meta": metas, "operations": selected}
        result["semantic"] = read_db(semantic, indices)
    paths = []
    for root, dirs, names in os.walk(vault / "buckets", followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(root) / name).is_symlink()]
        paths += [Path(root) / name for name in names if name.endswith(".md")]
    require(len(paths) <= limits["totalNativeMarkdown"], "VAULT_BODY_BOUND")
    import frontmatter
    allowed_native_ids = {row["receipt"]["metadata"]["nativeId"] for row in result["journal"]["operations"] if row["receipt"]}
    result["nativeBodies"] = []
    new_ids = {row["receipt"]["metadata"]["nativeId"] for row in result["journal"]["operations"]
               if row["receipt"] and row["operationId"] != scope["previousMemoryOperationId"]}
    require(len(new_ids) <= 1, "NEW_MEMORY_BOUND")
    synthetic_body = None
    for path in sorted(paths):
        raw, fingerprint = stable_read(path, 65536)
        post = frontmatter.loads(raw.decode("utf-8"))
        require(post.metadata.get("id") in allowed_native_ids, "NATIVE_BODY_SCOPE")
        body = post.content.encode("utf-8")
        if post.metadata["id"] in new_ids:
            synthetic_body = post.content
        result["nativeBodies"].append({"nativeId": post.metadata["id"], **fingerprint,
            "bodyDigest": sha(body), "bodyBytes": len(body), "bodyIncluded": False})
    return result, synthetic_body


def comparisons(snapshot, baseline, previous):
    def delta(old):
        prior = {v["sessionId"]: v for v in old["native"]["files"]}
        changes, types, unchanged = [], Counter(), True
        for item in snapshot["native"]["files"]:
            before = prior.get(item["sessionId"])
            count = len(before["events"]) if before else 0
            prefix = not before or (item["headerHash"] == before["headerHash"] and
                [v["eventHash"] for v in item["events"][:count]] == [v["eventHash"] for v in before["events"]])
            added = item["events"][count:] if prefix else []
            if before and any(item[k] != before[k] for k in ("bytes", "sha256", "mtimeNs")):
                unchanged = False
            if not before:
                unchanged = False
            types.update(event["type"] for event in added)
            changes.append({"sessionId": item["sessionId"], "previousEventPrefixUnchanged": prefix, "newFile": before is None, "addedEvents": added})
        forbidden = {kind: count for kind, count in types.items() if kind.startswith(("request/", "assistant/", "turn/", "step/")) or any(part in kind.lower() for part in ("compaction", "title"))}
        return {"filesUnchanged": unchanged, "deltas": changes, "addedTypeCounts": dict(types),
                "generationOrCompactionEventCounts": forbidden, "zeroObservedGenerationEvents": not forbidden and all(v["previousEventPrefixUnchanged"] for v in changes),
                "onlyUserMessageAdded": bool(types) and set(types) == {"user/message"}}
    return {"fromBaseline": delta(baseline), "fromPrevious": delta(previous),
        "controlMetadataUnchangedFromPrevious": snapshot["control"]["metadataSha256"] == previous["control"]["metadataSha256"]}


def collect(stage, plan, previous=None, baseline=None):
    scope = plan["scope"]
    control = control_snapshot(scope)
    runtime = runtime_snapshot(scope, control)
    backend, synthetic_body = backend_snapshot(scope, control["memoryOperationIds"], plan["limits"])
    result = {"schemaVersion": 1, "stage": stage, "capturedAt": now(), "scopeSha256": sha(canonical(scope).encode()),
        "auditScriptSha256": sha(Path(__file__).read_bytes()), "control": control, "runtime": runtime,
        "backend": backend,
        "native": native_snapshot(scope, control, runtime, plan["limits"], previous, synthetic_body),
        "limitations": ["Independent per-store read transactions, not a distributed atomic snapshot",
            "No full-machine model/network/cost accounting", "Search/query results may be transient and require separate root evidence",
            "Epoch retirement is not physical deletion of prior native Session history"]}
    if baseline and previous:
        result["comparisons"] = comparisons(result, baseline, previous)
    # Match receipts to persisted user/message, not to generated text or an event count.
    observed = {(row["sessionId"], event["seq"]): event for row in result["native"]["files"] for event in row["events"]}
    result["nativeReceiptChecks"] = []
    for row in control["records"]["replyOperations"]:
        receipt = row["metadata"].get("contextReceipt")
        if receipt:
            event = observed.get((receipt["sessionId"], receipt["userMessageSeq"]))
            result["nativeReceiptChecks"].append({"operationId": row["metadata"]["operationId"],
                "confirmed": receipt.get("durability") == "confirmed", "sessionId": receipt["sessionId"],
                "messageId": receipt["messageId"], "messageHash": receipt["messageHash"], "userMessageSeq": receipt["userMessageSeq"],
                "exactNativeMessage": bool(event and event["type"] == "user/message" and event.get("messageId") == receipt["messageId"] and event.get("messageHash") == receipt["messageHash"])})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=STAGES, nargs="?")
    parser.add_argument("--init-plan", action="store_true")
    args = parser.parse_args()
    require(bool(args.stage) != args.init_plan, "SELECT_PLAN_OR_STAGE")
    raw, _ = stable_read(SOURCE)
    artifact = json.loads(raw)
    expected_scope = scope_from_source(artifact)
    if args.init_plan:
        exclusive_json(PLAN, make_plan(artifact, sha(raw)))
        print(json.dumps({"status": "plan-only-no-host-read", "plan": str(PLAN)}))
        return
    plan = json_file(PLAN)
    require(plan["schemaVersion"] == 1 and plan["sourceArtifactSha256"] == sha(raw) and plan["scope"] == expected_scope
            and plan["stages"] == list(STAGES) and plan["limits"] == make_plan(artifact, sha(raw))["limits"], "PLAN_CHANGED")
    output = BASE / ".local" / f"phase3f-host-{args.stage}.json"
    require(not output.exists() and not output.is_symlink(), "STAGE_EXISTS")
    number = STAGES.index(args.stage)
    previous = json_file(BASE / ".local" / f"phase3f-host-{STAGES[number - 1]}.json") if number else None
    baseline = json_file(BASE / ".local/phase3f-host-baseline.json") if number else None
    if previous:
        require(previous["scopeSha256"] == sha(canonical(expected_scope).encode()), "PRIOR_SCOPE_CHANGED")
    result = collect(args.stage, plan, previous, baseline)
    exclusive_json(output, result)
    print(json.dumps({"stage": args.stage, "snapshot": str(output), "sha256": sha(output.read_bytes()),
                      "nativeFiles": len(result["native"]["files"]), "bodyIncluded": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Exception strings from parsers/drivers can include source lines/body.
        code = str(error) if isinstance(error, AuditError) else type(error).__name__
        print(json.dumps({"error": code, "snapshotPublished": False}), file=sys.stderr)
        raise SystemExit(1)
