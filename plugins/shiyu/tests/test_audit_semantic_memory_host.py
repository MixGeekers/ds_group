"""Synthetic-only audit fixtures; never use runtime/ or a real DSH Session."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import zstandard

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("semantic_host_audit", BASE / "scripts/audit-semantic-memory-host.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
BODY = "SYNTHETIC AUDIT BODY — must never appear in any persisted snapshot."


def encode(rows):
    return zstandard.ZstdCompressor().compress(("\n".join(audit.canonical(v) for v in rows) + "\n").encode())


class Fixture(unittest.TestCase):
    def setUp(self):
        scratch = BASE / ".local"
        scratch.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="audit-fixture-", dir=scratch)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.roots = [self.root / f"sessions-{i}" for i in range(3)]
        for root in self.roots:
            root.mkdir()
        self.sessions = []
        for index in range(7):
            sid = f"shiyu-replyer-fixture-{index}"
            path = self.roots[index % 3] / sid / "session.v4.jsonl.zstd"
            path.parent.mkdir()
            path.write_bytes(encode([{"format": 4, "privateHeader": BODY}]))
            self.sessions.append({"sessionId": sid, "file": str(path)})
        self.scope = {"controlDb": str(self.root / "control.sqlite"), "runtimeState": str(self.root / "runtime.json"),
            "ownedMemoryVault": str(self.root / "vault"), "backendConfig": str(self.root / "backend.json"),
            "conversationId": "conversation-1", "bindingId": "binding-1", "taskIds": ["task-1", "task-2"],
            "exactSessionRoots": list(map(str, self.roots)), "ownedNativeSessions": self.sessions,
            "backendId": "backend-1", "deploymentId": "deployment-1", "scope": "local-owner", "previousMemoryOperationId": "old-memory"}
        self.binding = {"bindingId": "binding-1", "conversationId": "conversation-1", "scope": "local-owner",
            "businessId": "business-1", "sessionEpoch": 1, "sessionId": self.sessions[0]["sessionId"]}
        self.runtime = {"bindings": [{"role": "replyer", "scope": "local-owner", "businessId": "business-1",
                                      "sessionId": self.sessions[0]["sessionId"], "secretBody": BODY}], "paused": False}
        Path(self.scope["runtimeState"]).write_text(json.dumps(self.runtime))
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.executescript("""
                CREATE TABLE shiyu_reply_bindings(id TEXT,conversation_id TEXT,scope TEXT,record_json TEXT);
                CREATE TABLE shiyu_reply_sessions(session_id TEXT,binding_id TEXT,epoch INTEGER,scope TEXT);
                CREATE TABLE shiyu_local_memory_operations(operation_id TEXT,conversation_id TEXT,source_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_local_reply_inputs(operation_id TEXT,conversation_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_local_memory_meta(id INTEGER,backend_id TEXT,deployment_id TEXT);
                INSERT INTO shiyu_local_memory_meta VALUES(1,'backend-1','deployment-1');
                CREATE TABLE shiyu_commit_watermark(id INTEGER,commit_seq INTEGER,baseline_id TEXT);
                INSERT INTO shiyu_commit_watermark VALUES(1,1,'baseline-1');
            """)
            db.execute("INSERT INTO shiyu_reply_bindings VALUES(?,?,?,?)", ("binding-1", "conversation-1", "local-owner", json.dumps(self.binding)))
            db.execute("INSERT INTO shiyu_reply_sessions VALUES(?,?,?,?)", (self.binding["sessionId"], "binding-1", 1, "local-owner"))
        vault = Path(self.scope["ownedMemoryVault"])
        (vault / ".shiyu").mkdir(parents=True)
        (vault / "buckets/dynamic").mkdir(parents=True)
        with sqlite3.connect(vault / ".shiyu/operations.sqlite3") as db:
            db.executescript("CREATE TABLE installation(singleton INTEGER,binding TEXT); CREATE TABLE operations(operation_id TEXT,command_json TEXT,digest TEXT,planned_id TEXT,state TEXT,receipt_json TEXT,error TEXT);")
            db.execute("INSERT INTO installation VALUES(1,?)", (audit.canonical({key: self.scope[key] for key in ("backendId", "deploymentId", "scope")}),))
        artifact = {"scope": {key: value for key, value in self.scope.items() if key not in ("backendId", "deploymentId", "scope", "previousMemoryOperationId")},
            "result": {"deploymentId": "deployment-1", "operationId": "old-memory"},
            "checkpoints": {"post-refresh": {"backend": {"configuration": {"backendId": "backend-1"}}}}}
        self.plan = audit.make_plan(artifact, "a" * 64)

    def add_memory(self, operation_id="new-memory", native_id="shiyu_" + "a" * 32):
        command = {"schemaVersion": 1, "kind": "create", "operationId": operation_id, "backendId": "backend-1",
            "scope": "local-owner", "targetRef": "target-1", "bodyDigest": audit.sha(BODY.encode()), "bodyBytes": len(BODY.encode()),
            "sourceRefs": [{"sourceId": "source-1", "revision": 1}]}
        local = {"operationId": operation_id, "conversationId": "conversation-1", "sourceId": "source-1", "command": command, "body": BODY}
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.execute("INSERT INTO shiyu_local_memory_operations VALUES(?,?,?,?)", (operation_id, "conversation-1", "source-1", json.dumps(local)))
        vault = Path(self.scope["ownedMemoryVault"])
        receipt = {"nativeId": native_id, "bodyDigest": command["bodyDigest"], "bodyBytes": command["bodyBytes"]}
        with sqlite3.connect(vault / ".shiyu/operations.sqlite3") as db:
            db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,NULL)", (operation_id, audit.canonical(command), "a"*64, native_id, "applied", json.dumps(receipt)))
        (vault / "buckets/dynamic" / f"{native_id}.md").write_text(f"---\nid: {native_id}\ntype: dynamic\n---\n\n{BODY}\n")
        return command

    def append(self, sid, event):
        path = next(Path(row["file"]) for row in self.sessions if row["sessionId"] == sid)
        with path.open("ab") as stream:
            stream.write(encode([event]))

    def test_baseline_is_readonly_and_output_excludes_all_bodies(self):
        self.add_memory()
        before = Path(self.scope["controlDb"]).read_bytes()
        snapshot = audit.collect("baseline", self.plan)
        self.assertEqual(before, Path(self.scope["controlDb"]).read_bytes())
        self.assertEqual(len(snapshot["native"]["files"]), 7)
        self.assertNotIn(BODY, json.dumps(snapshot, ensure_ascii=False))
        self.assertEqual(snapshot["backend"]["nativeBodies"][0]["bodyDigest"], audit.sha(BODY.encode()))

    def test_sqlite_authorizer_refuses_writes_and_missing_db_is_not_created(self):
        with self.assertRaises(sqlite3.DatabaseError):
            audit.read_db(Path(self.scope["controlDb"]), lambda db: db.execute("UPDATE shiyu_commit_watermark SET commit_seq=999"))
        missing = self.root / "absent.sqlite"
        with self.assertRaises(FileNotFoundError):
            audit.read_db(missing, lambda db: None)
        self.assertFalse(missing.exists())

    def test_concatenated_frames_match_exact_user_receipt_without_text(self):
        baseline = audit.collect("baseline", self.plan)
        self.add_memory()
        message = {"id": "message-1", "role": "user", "source": {"kind": "user"}, "content": [{"type": "text", "text": BODY}]}
        self.append(self.binding["sessionId"], {"seq": 0, "type": "user/message", "data": message})
        receipt = {"sessionId": self.binding["sessionId"], "userMessageSeq": 0, "messageId": message["id"], "messageHash": audit.sha(audit.canonical(message).encode()), "durability": "confirmed"}
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.execute("INSERT INTO shiyu_local_reply_inputs VALUES(?,?,?)", ("reply-1", "conversation-1", json.dumps({"operationId": "reply-1", **self.binding, "contextReceipt": receipt, "body": BODY})))
        snapshot = audit.collect("load-only", self.plan, baseline, baseline)
        self.assertTrue(snapshot["nativeReceiptChecks"][0]["exactNativeMessage"])
        self.assertTrue(snapshot["comparisons"]["fromPrevious"]["onlyUserMessageAdded"])
        self.assertTrue(snapshot["comparisons"]["fromPrevious"]["zeroObservedGenerationEvents"])
        event = next(v for v in snapshot["native"]["files"] if v["sessionId"] == self.binding["sessionId"])["events"][0]
        self.assertTrue(event["knownSyntheticBodyPresent"])
        self.assertNotIn(BODY, json.dumps(snapshot, ensure_ascii=False))

    def test_request_and_assistant_added_events_prevent_zero_generation_claim(self):
        baseline = audit.collect("baseline", self.plan)
        self.append(self.binding["sessionId"], {"seq": 0, "type": "request/header", "data": {"private": BODY}})
        self.append(self.binding["sessionId"], {"seq": 1, "type": "assistant/message", "data": {"message": {"id": "assistant-1", "role": "assistant", "content": [{"type": "text", "text": BODY}]}}})
        result = audit.collect("load-only", self.plan, baseline, baseline)
        self.assertFalse(result["comparisons"]["fromPrevious"]["zeroObservedGenerationEvents"])
        self.assertEqual(result["comparisons"]["fromPrevious"]["generationOrCompactionEventCounts"]["request/header"], 1)
        self.assertNotIn(BODY, json.dumps(result))

    def test_unbound_session_is_never_opened_and_authorized_new_epoch_is_admitted(self):
        sid = "shiyu-replyer-new-epoch"
        path = self.roots[0] / sid / "session.v4.jsonl.zstd"
        path.parent.mkdir()
        path.write_bytes(b"INVALID UNAUTHORIZED FILE")
        first = audit.collect("baseline", self.plan)
        self.assertEqual(len(first["native"]["files"]), 7)
        path.write_bytes(encode([{"format": 4}, {"seq": 0, "type": "user/message", "data": {"id": "empty-1", "role": "user", "content": [{"type": "text", "text": "No memories"}]}}]))
        self.binding.update(sessionId=sid, sessionEpoch=2, businessId="business-2")
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.execute("UPDATE shiyu_reply_bindings SET record_json=?", (json.dumps(self.binding),))
            db.execute("INSERT INTO shiyu_reply_sessions VALUES(?,?,?,?)", (sid, "binding-1", 2, "local-owner"))
        self.runtime["bindings"].append({"role": "replyer", "scope": "local-owner", "businessId": "business-2", "sessionId": sid})
        Path(self.scope["runtimeState"]).write_text(json.dumps(self.runtime))
        second = audit.collect("post-withdraw-load", self.plan, first, first)
        self.assertEqual(len(second["native"]["files"]), 8)
        self.assertTrue(second["comparisons"]["fromPrevious"]["zeroObservedGenerationEvents"])

    def test_exclusive_stage_preserves_history_and_symlink_files_are_rejected(self):
        out = self.root / "snapshot.json"
        audit.exclusive_json(out, {"first": True})
        with self.assertRaises(FileExistsError):
            audit.exclusive_json(out, {"first": False})
        self.assertEqual(json.loads(out.read_text()), {"first": True})
        path = Path(self.sessions[0]["file"])
        original = path.with_name("original")
        path.rename(original)
        path.symlink_to(original)
        with self.assertRaises(audit.AuditError):
            audit.collect("baseline", self.plan)

    def test_native_gap_oversize_and_rewritten_prefix_fail_closed(self):
        path = Path(self.sessions[0]["file"])
        path.write_bytes(encode([{}, {"seq": 1, "type": "user/message", "data": {"id": "m"}}]))
        with self.assertRaisesRegex(audit.AuditError, "NATIVE_SEQUENCE"):
            audit.collect("baseline", self.plan)
        path.write_bytes(encode([{}]))
        limited = copy.deepcopy(self.plan)
        limited["limits"]["decodedSessionBytes"] = 1
        with self.assertRaisesRegex(audit.AuditError, "NATIVE_DECODE_BOUND"):
            audit.collect("baseline", limited)
        path.write_bytes(encode([{}, {"seq": 0, "type": "user/message", "data": {"id": "m", "content": []}}]))
        first = audit.collect("baseline", self.plan)
        path.write_bytes(encode([{}, {"seq": 0, "type": "user/message", "data": {"id": "changed", "content": []}}]))
        second = audit.collect("reload", self.plan, first, first)
        self.assertFalse(second["comparisons"]["fromPrevious"]["zeroObservedGenerationEvents"])

    def test_unknown_content_fields_never_escape_metadata_projection(self):
        value = {"body": BODY, "query": BODY, "text": BODY, "content": BODY, "meaning": BODY,
                 "observation": {"content": {"digest": "a"*64, "vectorHash": "b"*64, "dimensions": 1024, "text": BODY, "vector": [1.2]}, "reason": BODY}}
        projected = audit.metadata(value)
        self.assertNotIn(BODY, json.dumps(projected, ensure_ascii=False))
        self.assertEqual(projected["observation"]["content"], {"digest": "a"*64, "vectorHash": "b"*64, "dimensions": 1024})

    def test_vault_scope_limit_stops_before_extra_body_parse(self):
        directory = Path(self.scope["ownedMemoryVault"]) / "buckets/dynamic"
        for i in range(3):
            (directory / f"unexpected-{i}.md").write_text(BODY)
        with self.assertRaisesRegex(audit.AuditError, "VAULT_BODY_BOUND"):
            audit.collect("baseline", self.plan)

    def test_index_and_exposure_metadata_is_scoped_and_digest_only(self):
        self.add_memory()
        command = {"memoryOperationId": "new-memory", "backendId": "backend-1", "deploymentId": "deployment-1", "scope": "local-owner", "body": BODY}
        source = {"operationId": "new-memory", "conversationId": "conversation-1", "readToken": {"backendId": "backend-1", "deploymentId": "deployment-1"}, "body": BODY}
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.executescript("""CREATE TABLE shiyu_memory_index_operations(index_operation_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_memory_index_receipts(index_operation_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_local_reply_memory_exposures(operation_id TEXT,source_id TEXT,binding_id TEXT,record_json TEXT);""")
            db.execute("INSERT INTO shiyu_memory_index_operations VALUES('index-1',?)", (json.dumps({"command": command, "embeddingUsage": {"calls": 1}}),))
            db.execute("INSERT INTO shiyu_memory_index_receipts VALUES('index-1',?)", (json.dumps({"content": {"digest": "a"*64, "vectorHash": "b"*64, "dimensions": 1024, "body": BODY}}),))
            db.execute("INSERT INTO shiyu_local_reply_memory_exposures VALUES('reply-1','source-1','binding-1',?)", (json.dumps({"source": source}),))
        snapshot = audit.collect("index", self.plan)
        self.assertEqual(len(snapshot["control"]["records"]["indexOperations"]), 1)
        self.assertEqual(len(snapshot["control"]["records"]["exposures"]), 1)
        self.assertNotIn(BODY, json.dumps(snapshot, ensure_ascii=False))
        command["deploymentId"] = "foreign-deployment"
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.execute("UPDATE shiyu_memory_index_operations SET record_json=?", (json.dumps({"command": command}),))
        with self.assertRaisesRegex(audit.AuditError, "INDEX_BINDING"):
            audit.collect("index", self.plan)

    def test_semantic_journal_wrong_binding_fails_closed_without_reading_vectors(self):
        semantic = Path(self.scope["ownedMemoryVault"]) / ".shiyu/semantic.sqlite3"
        with sqlite3.connect(semantic) as db:
            db.execute("CREATE TABLE meta(singleton INTEGER,binding TEXT,baseline TEXT,profile TEXT,watermark INTEGER)")
            db.execute("INSERT INTO meta VALUES(1,?,'index-baseline','profile',0)", (json.dumps({"backendId": "backend-1", "deploymentId": "foreign", "scope": "local-owner"}),))
        with self.assertRaisesRegex(audit.AuditError, "SEMANTIC_BINDING"):
            audit.collect("index", self.plan)

    def test_ascii_free_text_and_numeric_arrays_are_redacted_not_merely_character_filtered(self):
        values = {"input": "SecretMemory123", "reason": "private@example.com", "evidenceRefs": ["SecretMemory123"],
                  "observation": {"content": {"digest": [1.2, 3.4, 5.6]}, "input": [1.2, 3.4]}}
        output = json.dumps(audit.metadata(values))
        for forbidden in ("SecretMemory123", "private@example.com", "1.2", "3.4", "5.6"):
            self.assertNotIn(forbidden, output)

    def test_local_memory_deployment_is_verified_before_selecting_operation_ids(self):
        with sqlite3.connect(self.scope["controlDb"]) as db:
            db.execute("UPDATE shiyu_local_memory_meta SET deployment_id='foreign'")
        with self.assertRaisesRegex(audit.AuditError, "MEMORY_DEPLOYMENT"):
            audit.collect("save", self.plan)


if __name__ == "__main__":
    unittest.main()
