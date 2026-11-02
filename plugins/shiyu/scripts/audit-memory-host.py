"""Read-only, scoped phase-3E audit. Never instantiate the product ControlStore.

SQLite URI mode=ro, query_only, read transaction; seven exact native files are
hashed as compressed bytes without parsing any prompt/message body. Writes only
this phase's evidence JSON under artifacts/ and .local/.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from urllib.parse import quote

BASE = Path(__file__).resolve().parents[1]
ARTIFACT = BASE / "artifacts/memory-host-validation.json"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def pick(value, keys):
    return {key: value[key] for key in keys if key in value}


def read_db(path, callback):
    connection = sqlite3.connect("file:" + quote(str(path)) + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        assert connection.execute("PRAGMA query_only").fetchone()[0] == 1
        return callback(connection)
    finally:
        connection.rollback()
        connection.close()


def control_snapshot(scope):
    def query(db):
        all_rows = lambda sql, args=(): [dict(row) for row in db.execute(sql, args).fetchall()]
        tables = {row["name"] for row in all_rows("SELECT name FROM sqlite_schema WHERE type='table'")}
        def rows(table, columns="*", clause="", args=()):
            return all_rows("SELECT " + columns + " FROM " + table + " " + clause, args) if table in tables else None
        def records(table, clause="", args=(), column="record_json"):
            return [json.loads(row[column]) for row in rows(table, column, clause, args)] if table in tables else None
        task_ids = scope["taskIds"]
        task_records = records("shiyu_task_record", "WHERE id IN (?,?) ORDER BY id", task_ids, "value")
        tasks = [dict(pick(task, ["taskId", "version", "createdAt", "updatedAt", "mandateId", "mandateVersion", "requestScope"]),
                      terminal=pick(task.get("terminal", {}), ["state", "at", "evidenceRefs"]),
                      uncertainty=pick(task.get("uncertainty", {}), ["at", "evidenceRefs"]),
                      verification=pick(task.get("verification", {}), ["verdict", "at", "evidenceRefs", "resultHash"])) for task in task_records]
        for task in tasks:
            task["observedState"] = task["terminal"].get("state", "unknown" if task["uncertainty"] else None)
        goal_id = "artifact-validation:" + task_ids[1]
        goal_bindings = records("shiyu_goal_bindings", "WHERE goal_id=?", (goal_id,), "value")
        goal_commands = records("shiyu_goal_commands", "WHERE goal_id=? ORDER BY first_metadata_version", (goal_id,), "value")
        cid, bid = scope["conversationId"], scope["bindingId"]
        selected_counts = {table: rows(table, "count(*) AS count")[0]["count"] for table in sorted(tables) if table in {
            "shiyu_task_record", "shiyu_task_runs", "shiyu_goal_bindings", "shiyu_goal_commands", "shiyu_conversations", "shiyu_reply_bindings",
            "shiyu_reply_sessions", "shiyu_local_reply_inputs", "shiyu_reply_drafts", "shiyu_memory_operations", "shiyu_memory_receipts",
            "shiyu_memory_publications", "shiyu_local_memory_operations", "shiyu_local_memory_sources", "shiyu_local_memory_withdrawals"}}
        return {"path": scope["controlDb"], "sqliteMode": "ro", "queryOnly": True, "auditSqliteVersion": sqlite3.sqlite_version,
            "watermark": rows("shiyu_commit_watermark"), "dirtyMarkerCount": rows("shiyu_commit_dirty", "count(*) AS count")[0]["count"],
            "counts": selected_counts, "tasks": tasks,
            "workerRuns": [pick(run, ["taskId", "assignmentId", "state", "sessionId", "fencingToken", "reservationId"]) for run in records("shiyu_task_runs", "WHERE task_id IN (?,?) ORDER BY task_id", task_ids, "value")],
            "goals": [pick(goal, ["goalId", "sessionId", "scope", "metadataVersion", "goalRef", "completionCriteriaHash"]) for goal in goal_bindings],
            "goalCommands": [pick(command, ["commandId", "operation", "status", "expectedRef", "observedRef", "postconditionHash"]) for command in goal_commands],
            "conversation": records("shiyu_conversations", "WHERE id=?", (cid,)),
            "binding": records("shiyu_reply_bindings", "WHERE id=?", (bid,)),
            "pending": records("shiyu_background_pending", "WHERE binding_id=? ORDER BY ref_key", (bid,)),
            "sourceCursors": rows("shiyu_reply_source_cursors", "*", "WHERE binding_id=? ORDER BY ref_key", (bid,)),
            "nativeReplyBinding": rows("shiyu_reply_sessions", "*", "WHERE binding_id=?", (bid,)),
            "publishedState": rows("shiyu_state_publication_head", "id,state_version"),
            "authority": {"meta": rows("shiyu_policy_meta"), "legacyCatalog": rows("shiyu_policy_catalog"),
                "catalogState": rows("shiyu_policy_catalog_state"), "migrationReceipts": records("shiyu_policy_catalog_migrations"),
                "revisionObservation": "explicit catalog state" if "shiyu_policy_catalog_state" in tables else "legacy hash-only catalog; explicit revision table absent"},
            "memory": {"localMeta": rows("shiyu_local_memory_meta"), "ledgerMeta": rows("shiyu_memory_meta"),
                "localOperations": records("shiyu_local_memory_operations", "WHERE conversation_id=? ORDER BY operation_id", (cid,)),
                "sources": records("shiyu_local_memory_sources", "ORDER BY source_id"),
                "operations": records("shiyu_memory_operations", "ORDER BY operation_id"),
                "receipts": records("shiyu_memory_receipts", "ORDER BY receipt_id"),
                "publications": records("shiyu_memory_publications", "ORDER BY operation_id,local_version"),
                "withdrawals": rows("shiyu_local_memory_withdrawals"),
                "tombstones": rows("shiyu_memory_tombstones")},
            "eventsByScopeAndType": all_rows("SELECT scope,type,count(*) AS count FROM events GROUP BY scope,type ORDER BY scope,type")}
    return read_db(Path(scope["controlDb"]), query)


def native_snapshot(scope):
    result = []
    roots = {Path(root) for root in scope["exactSessionRoots"]}
    assert len(scope["ownedNativeSessions"]) == 7 and len(roots) == 3
    for known in scope["ownedNativeSessions"]:
        path = Path(known["file"])
        assert path.parent.parent in roots and path.parent.name == known["sessionId"] and path.name == "session.v4.jsonl.zstd"
        assert not path.is_symlink()
        before = path.stat()
        assert before.st_size < 20 * 1024 * 1024
        raw = path.read_bytes()
        after = path.stat()
        assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), "Native file changed while hashing"
        result.append({**known, "bytes": len(raw), "sha256": sha(raw), "mtimeNs": str(after.st_mtime_ns),
                       "mtime": datetime.fromtimestamp(after.st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                       "stableDuringRead": True, "decoded": False})
    inventory = [{"root": str(root), "sessionIds": sorted(child.name for child in root.iterdir() if child.is_dir() and not child.is_symlink() and child.name.startswith("shiyu-"))} for root in sorted(roots)]
    return {"files": result, "inventory": inventory, "count": len(result), "bodyParsingPerformed": False}


def runtime_snapshot(scope):
    path = Path(scope["runtimeState"])
    raw = path.read_bytes()
    value = json.loads(raw)
    return {"sha256": sha(raw), "paused": value.get("paused"), "sessionBindingCount": len(value.get("bindings", [])),
        "bindings": [pick(binding, ["key", "role", "businessId", "scope", "sessionId", "status", "createdAt", "updatedAt"]) for binding in value.get("bindings", [])],
        "lastContextVerification": pick(value.get("lastContextVerification", {}), ["at", "ok", "instanceId", "calls", "conversationId", "sessionId"])}


def backend_snapshot(scope):
    config = Path(scope["backendConfig"])
    vault = Path(scope["ownedMemoryVault"])
    result = {"configurationPresent": config.is_file(), "vaultPresent": vault.exists()}
    if config.is_file():
        raw = config.read_bytes()
        value = json.loads(raw)
        result.update(configSha256=sha(raw), configMode=oct(config.stat().st_mode & 0o777),
                      configuration=pick(value, ["schemaVersion", "backendId", "deploymentId", "scope", "embedding"]))
    journal = vault / ".shiyu/operations.sqlite3"
    result["journalPresent"] = journal.is_file()
    if journal.is_file():
        def query(db):
            metadata = [dict(row) for row in db.execute("SELECT * FROM installation")]
            rows = [dict(row) for row in db.execute("SELECT * FROM operations ORDER BY operation_id")]
            for row in rows:
                for field in ("command_json", "receipt_json"):
                    row[field] = json.loads(row[field]) if row[field] else None
            return {"sqliteMode": "ro", "installation": metadata, "operations": rows}
        result["journal"] = read_db(journal, query)
        # Only this explicitly owned, initially absent, single-synthetic vault.
        # Parse the one body for a digest, never return its text. Unexpected
        # additional files stop the body-reading portion of this bounded audit.
        paths = [path for path in sorted((vault / "buckets").rglob("*.md")) if not path.is_symlink()]
        result["markdownFileCount"] = len(paths)
        result["markdownFiles"] = []
        if len(paths) <= 1:
            import frontmatter
            for path in paths:
                stat = path.stat()
                assert stat.st_size < 65536
                raw = path.read_bytes()
                post = frontmatter.loads(raw.decode("utf-8"))
                body = post.content.encode("utf-8")
                after = path.stat()
                assert (stat.st_size, stat.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
                result["markdownFiles"].append({"relativePath": str(path.relative_to(vault)), "bytes": len(raw), "sha256": sha(raw),
                    "mtimeNs": str(after.st_mtime_ns), "bodyDigest": sha(body), "bodyBytes": len(body),
                    "metadata": pick(dict(post.metadata), ["id", "type", "source_tool", "grow_batch_id", "provenance", "deleted_at", "tombstone"]),
                    "bodyIncluded": False, "stableDuringRead": True})
        else:
            result["bodyAuditStopped"] = "More native Markdown files than the frozen one-create scope"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("baseline", "post-reload-pre-save", "post-save", "post-restart-read", "post-withdraw", "post-refresh"))
    args = parser.parse_args()
    artifact = json.loads(ARTIFACT.read_text())
    if args.stage in artifact["checkpoints"]:
        raise ValueError("Checkpoint already exists; retain history rather than overwrite")
    scope = artifact["scope"]
    assert scope["controlDb"] == str(BASE / ".local/runtime/control/events.sqlite")
    snapshot = {"stage": args.stage, "capturedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "control": control_snapshot(scope), "native": native_snapshot(scope), "runtime": runtime_snapshot(scope), "backend": backend_snapshot(scope),
                "auditScriptSha256": sha(Path(__file__).read_bytes())}
    snapshot["controlMetadataSha256"] = sha(canonical(snapshot["control"]).encode())
    baseline = artifact["checkpoints"].get("baseline")
    if baseline:
        old = {row["sessionId"]: row for row in baseline["native"]["files"]}
        snapshot["comparisons"] = {"allSevenNativeFilesUnchanged": all(all(row[key] == old[row["sessionId"]][key] for key in ("bytes", "sha256", "mtimeNs")) for row in snapshot["native"]["files"]),
            "scopedNativeInventoryUnchanged": snapshot["native"]["inventory"] == baseline["native"]["inventory"],
            "tasksUnchanged": snapshot["control"]["tasks"] == baseline["control"]["tasks"],
            "goalsUnchanged": snapshot["control"]["goals"] == baseline["control"]["goals"],
            "sourceCursorsUnchanged": snapshot["control"]["sourceCursors"] == baseline["control"]["sourceCursors"]}
    local = BASE / ".local" / ("phase3e-" + args.stage + ".json")
    local.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
    artifact["checkpoints"][args.stage] = snapshot
    artifact["status"] = "baseline-recorded-awaiting-host-actions" if args.stage == "baseline" else "host-evidence-in-progress"
    artifact["auditScript"] = {"path": str(Path(__file__).relative_to(BASE)), "sha256": sha(Path(__file__).read_bytes()), "sqliteOpenMode": "URI mode=ro; PRAGMA query_only=ON; BEGIN/ROLLBACK"}
    ARTIFACT.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"stage": args.stage, "capturedAt": snapshot["capturedAt"], "commitSeq": snapshot["control"]["watermark"][0]["commit_seq"],
        "ownedNativeSessions": snapshot["native"]["count"], "counts": snapshot["control"]["counts"],
        "authority": snapshot["control"]["authority"], "backend": snapshot["backend"], "comparisons": snapshot.get("comparisons")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
