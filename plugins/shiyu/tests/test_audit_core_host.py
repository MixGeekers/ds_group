"""Synthetic Core audit fixtures only: no real Session, host, model or credentials."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import zstandard

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("core_host_audit", BASE / "scripts/audit-core-host.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
BODY = "SYNTHETIC CORE AUDIT BODY — must never escape a digest-only report."
ASCII_BODY = "PrivateCoreBody123"


def encode(rows):
    return zstandard.ZstdCompressor().compress(("\n".join(audit.canonical(row) for row in rows) + "\n").encode())


class Fixture(unittest.TestCase):
    def setUp(self):
        scratch = BASE / ".local"
        scratch.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="core-audit-fixture-", dir=scratch)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.database = self.root / "control.sqlite"
        self.session_root = self.root / "sessions"
        self.workspace_root = self.root / "workspaces"
        self.session_root.mkdir()
        self.workspace_root.mkdir()
        self.goal_id = "core-" + "a" * 40
        self.session_id = "shiyu-core-" + "b" * 64
        self.plan = {"schemaVersion": 1, "phase": "3G", "runId": "core-audit-fixture", "executionPlanSha256": "c" * 64,
            "goalId": self.goal_id, "requestId": "fixture-owner-request", "objectiveSha256": audit.sha(BODY.encode()),
            "deliverables": [{"id": "note", "sha256": audit.sha(BODY.encode()), "bytes": len(BODY.encode())}],
            "budget": {"tokens": 65536, "calls": 6, "effects": 1}, "maxEvaluations": 2,
            "paths": {"controlDb": str(self.database), "sessionRoots": [str(self.session_root)], "workspaceRoot": str(self.workspace_root)},
            "sessions": [{"role": "core", "sessionId": self.session_id}],
            "limits": {"coreRounds": 2, "workers": 1, "compressedSessionBytes": 16777216,
                       "decodedSessionBytes": 67108864, "nativeEventRows": 4096}}

    def write_session(self, session_id, rows):
        path = self.session_root / session_id / "session.v4.jsonl.zstd"
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(encode([{"format": 4, "privateHeader": BODY}] + rows))
        return path

    def put(self, table, key, value, record, column="value"):
        with sqlite3.connect(self.database) as db:
            db.execute(f'DELETE FROM "{table}" WHERE "{key}"=?', (value,))
            db.execute(f'INSERT INTO "{table}"("{key}","{column}") VALUES(?,?)', (value, audit.canonical(record)))

    def collection_fixture(self):
        self.goal_ref = {"id": "native-goal-1", "revision": 1}
        self.goal = {"schemaVersion": 1, "goalId": self.goal_id, "requestId": self.plan["requestId"], "objective": BODY,
            "deliverables": [{"id": "note", "title": ASCII_BODY, "content": BODY}], "budget": self.plan["budget"],
            "maxEvaluations": 2, "taskRefs": [], "completionCriteria": BODY, "completionCriteriaHash": "d" * 64,
            "native": {"goalRef": self.goal_ref, "sessionId": self.session_id, "phase": "active"}}
        self.binding = {"goalId": self.goal_id, "ownerId": "local-owner", "scope": "local-owner", "sessionId": self.session_id,
            "goalRef": self.goal_ref, "completionCriteriaHash": self.goal["completionCriteriaHash"], "metadataVersion": 2,
            "receipt": {"commandId": "create-1", "operation": "create", "status": "confirmed", "observedRef": self.goal_ref,
                        "postconditionHash": "e" * 64, "reason": ASCII_BODY}}
        with sqlite3.connect(self.database) as db:
            db.executescript("""
                CREATE TABLE shiyu_core_goals(goal_id TEXT,value TEXT);
                CREATE TABLE shiyu_goal_bindings(goal_id TEXT,value TEXT);
                CREATE TABLE shiyu_goal_commands(goal_id TEXT,value TEXT);
                CREATE TABLE shiyu_core_evaluations(goal_id TEXT,value TEXT);
                CREATE TABLE shiyu_core_facts(goal_id TEXT,fact_id TEXT,consumed_by TEXT,value TEXT);
                CREATE TABLE shiyu_mandates(id TEXT,record_json TEXT);
                CREATE TABLE shiyu_budget_reservations(mandate_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_budget_receipts(reservation_id TEXT,result_json TEXT);
            """)
        self.put("shiyu_core_goals", "goal_id", self.goal_id, self.goal)
        self.put("shiyu_goal_bindings", "goal_id", self.goal_id, self.binding)
        self.put("shiyu_goal_commands", "goal_id", self.goal_id, self.binding["receipt"])
        self.native_goal = {**self.goal_ref, "phase": "active", "objective": BODY, "maxGoalRounds": 2}
        self.native_rows = [{"seq": 0, "type": "goal/change", "data": {"goal": self.native_goal, "roundsStarted": 0}}]
        self.native_path = self.write_session(self.session_id, self.native_rows)

    def add_evaluation(self, kind="no_action"):
        self.goal["mandateId"] = "mandate-1"
        self.goal["evaluations"] = 1
        self.put("shiyu_core_goals", "goal_id", self.goal_id, self.goal)
        self.put("shiyu_mandates", "id", "mandate-1", {"scope": "local-owner", "issuer": "local-owner", "limits": self.plan["budget"]}, "record_json")
        self.reservation = {"reservationId": "reservation-1", "mandateId": "mandate-1", "scope": "local-owner", "state": "settled",
                            "amount": {"tokens": 8192, "calls": 1, "effects": 0}, "observed": {"tokens": 10, "calls": 1, "effects": 0}}
        self.put("shiyu_budget_reservations", "mandate_id", "mandate-1", self.reservation, "record_json")
        candidate = {"kind": kind, "reason": ASCII_BODY}
        text = audit.canonical(candidate)
        user = {"id": "input-1", "role": "user", "content": [{"type": "text", "text": BODY}], "source": {"kind": "user"}}
        assistant = {"id": "assistant-1", "role": "assistant", "content": [{"type": "text", "text": text}]}
        self.native_rows.extend([{"seq": 1, "type": "user/message", "data": user},
                                 {"seq": 2, "type": "assistant/message", "data": {"message": assistant}}])
        self.write_session(self.session_id, self.native_rows)
        input_ref = {"sessionId": self.session_id, "eventSeq": 1, "messageId": user["id"], "messageHash": audit.native_message_hash(user), "durability": "confirmed"}
        assistant_ref = {"sessionId": self.session_id, "eventSeq": 2, "messageId": assistant["id"], "messageHash": audit.native_message_hash(assistant), "durability": "confirmed"}
        self.evaluation = {"evaluationId": "evaluation-1", "goalId": self.goal_id, "status": "committed", "triggerRefs": [], "candidate": candidate,
            "permit": {"goalId": self.goal_id, "goalRef": self.goal_ref, "mandateId": "mandate-1", "reservationId": "reservation-1"},
            "dispatch": {"goalId": self.goal_id, "goalRef": self.goal_ref, "roundId": "evaluation-1", "sessionId": self.session_id,
                         "messageId": user["id"], "messageHash": input_ref["messageHash"]},
            "nativeReceipt": {"roundId": "evaluation-1", "sessionId": self.session_id, "messageId": user["id"], "messageHash": input_ref["messageHash"],
                              "inputRef": input_ref, "assistantRef": assistant_ref, "outputHash": audit.sha(text.encode())}}
        self.put("shiyu_core_evaluations", "goal_id", self.goal_id, self.evaluation)

    def add_completed_task(self):
        task_id, effect_id, assignment_id = "d" * 32, "effect-1", "assignment-1"
        worker_id = "shiyu-worker-" + "e" * 64
        digest, byte_length = audit.sha(BODY.encode()), len(BODY.encode())
        self.goal["taskRefs"] = [{"taskId": task_id, "deliverableId": "note"}]
        self.goal["native"] = {"goalRef": {"id": self.goal_ref["id"], "revision": 2}, "sessionId": self.session_id, "phase": "complete"}
        self.put("shiyu_core_goals", "goal_id", self.goal_id, self.goal)
        self.binding["goalRef"] = self.goal["native"]["goalRef"]
        self.binding["receipt"] = {"commandId": "complete-1", "operation": "complete", "status": "confirmed", "postconditionHash": "f" * 64,
            "expectedRef": self.goal_ref, "observedRef": self.binding["goalRef"], "completionProof": {"goalRef": self.goal_ref,
                "completionCriteriaHash": self.goal["completionCriteriaHash"], "verifierId": "fixture-artifact-verifier", "evidenceRefs": ["artifact-observation:receipt-1"]}}
        self.put("shiyu_goal_bindings", "goal_id", self.goal_id, self.binding)
        self.put("shiyu_goal_commands", "goal_id", self.goal_id, self.binding["receipt"])
        with sqlite3.connect(self.database) as db:
            db.executescript("""
                CREATE TABLE shiyu_task_local_inputs(task_id TEXT,value TEXT);
                CREATE TABLE shiyu_task_record(id TEXT,value TEXT);
                CREATE TABLE shiyu_task_runs(task_id TEXT,value TEXT);
                CREATE TABLE shiyu_effects(seq INTEGER,record_json TEXT);
                CREATE TABLE shiyu_effect_receipts(effect_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_task_artifact_observations(effect_id TEXT,value TEXT);
                CREATE TABLE shiyu_effect_attempts(effect_id TEXT,record_json TEXT);
                CREATE TABLE shiyu_task_usage_observations(reservation_id TEXT,value TEXT);
            """)
            worker_reservation = {"reservationId": effect_id, "mandateId": "mandate-1", "scope": "local-owner", "state": "settled",
                                  "amount": {"tokens": 1024, "calls": 1, "effects": 1}, "observed": {"tokens": 100, "calls": 1, "effects": 1}}
            db.execute("INSERT INTO shiyu_budget_reservations VALUES(?,?)", ("mandate-1", audit.canonical(worker_reservation)))
        self.put("shiyu_task_local_inputs", "task_id", task_id, {"delegation": {"goalId": self.goal_id}, "mandateId": "mandate-1",
            "expectedSha256": digest, "byteLength": byte_length, "content": BODY, "artifactRef": "artifact:" + task_id})
        self.put("shiyu_task_record", "id", task_id, {"goalId": self.goal_id, "mandateId": "mandate-1", "terminal": {"state": "succeeded"},
            "ready": {"result": {"resultHash": digest, "effectRefs": [effect_id]}},
            "verification": {"resultHash": digest, "checks": [{"status": "pass"}]}})
        self.put("shiyu_task_runs", "task_id", task_id, {"taskId": task_id, "assignmentId": assignment_id, "sessionId": worker_id,
                                                       "state": "reported", "reservationId": effect_id})
        claim = {"claimToken": "claim-1", "fencingToken": 1}
        effect = {"effectId": effect_id, "status": "succeeded", "receiptId": "receipt-1", "authorization": {"mandateId": "mandate-1"},
                  "origin": {"kind": "task", "taskId": task_id, "assignmentId": assignment_id}, "currentClaim": claim}
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO shiyu_effects VALUES(1,?)", (audit.canonical(effect),))
        self.put("shiyu_effect_receipts", "effect_id", effect_id, {"receiptId": "receipt-1", "effectId": effect_id,
            "outcome": "succeeded", "claim": claim, "verification": {"verified": True}}, "record_json")
        self.put("shiyu_task_artifact_observations", "effect_id", effect_id, {"receiptId": "receipt-1", "matched": True,
            "observedSha256": digest, "observedBytes": byte_length})
        artifact = self.workspace_root / task_id / "artifacts" / "note.txt"
        artifact.parent.mkdir(parents=True)
        artifact.write_text(BODY)
        self.native_rows.append({"seq": 3, "type": "goal/change", "data": {"goal": {**self.native_goal, "revision": 2, "phase": "complete"}, "roundsStarted": 0}})
        self.write_session(self.session_id, self.native_rows)
        self.write_session(worker_id, [])
        self.plan["sessions"].append({"role": "worker", "sessionId": worker_id, "taskId": task_id, "assignmentId": assignment_id})
        return artifact

    def test_goal_binding_scope_and_command_journal_must_agree_before_reading_native_files(self):
        self.collection_fixture()
        original = copy.deepcopy(self.binding)
        for field, value in (("ownerId", "foreign-owner"), ("scope", "foreign-scope"), ("goalId", "foreign-goal"),
                             ("completionCriteriaHash", "f" * 64), ("receipt", {**original["receipt"], "commandId": "foreign-command"})):
            with self.subTest(field=field):
                changed = copy.deepcopy(original)
                changed[field] = value
                self.put("shiyu_goal_bindings", "goal_id", self.goal_id, changed)
                with patch.object(audit, "stable_read", side_effect=AssertionError("Unbound files cannot be read")), self.assertRaises(audit.AuditError):
                    audit.collect(self.plan)
        self.put("shiyu_goal_bindings", "goal_id", self.goal_id, original)
        changed = copy.deepcopy(self.goal)
        changed["native"]["sessionId"] = "foreign-session"
        self.put("shiyu_core_goals", "goal_id", self.goal_id, changed)
        result = audit.collect(self.plan)
        self.assertIn("NATIVE_BINDING_MISMATCH", [item["code"] for item in result["issues"]])
        self.assertFalse(result["completionVerified"])
        changed_plan = copy.deepcopy(self.plan)
        changed_plan["sessions"][0]["sessionId"] = "foreign-session"
        with self.assertRaisesRegex(audit.AuditError, "SESSION_SCOPE_NOT_FROZEN"):
            audit.collect(changed_plan)

    def test_exact_receipts_require_goal_session_sequence_identity_and_hash_not_matching_text_alone(self):
        self.collection_fixture()
        self.add_evaluation()
        result = audit.collect(self.plan)
        self.assertTrue(result["proofs"][0]["exactNativeInputAndAssistant"])
        self.assertEqual(result["issues"], [])
        original = copy.deepcopy(self.evaluation)
        changes = [
            (("nativeReceipt", "inputRef", "sessionId"), "foreign-session"),
            (("nativeReceipt", "inputRef", "eventSeq"), 0),
            (("nativeReceipt", "inputRef", "messageId"), "same-text-wrong-id"),
            (("nativeReceipt", "assistantRef", "messageHash"), "0" * 64),
            (("nativeReceipt", "outputHash"), "0" * 64),
            (("dispatch", "goalId"), "foreign-goal"),
            (("dispatch", "goalRef"), {"id": "foreign-native-goal", "revision": 1}),
        ]
        for keys, value in changes:
            with self.subTest(path=keys):
                changed = copy.deepcopy(original)
                target = changed
                for key in keys[:-1]: target = target[key]
                target[keys[-1]] = value
                self.put("shiyu_core_evaluations", "goal_id", self.goal_id, changed)
                result = audit.collect(self.plan)
                self.assertFalse(result["proofs"][0]["exactNativeInputAndAssistant"])
                self.assertIn("NATIVE_MESSAGE_PROOF", [item["code"] for item in result["issues"]])
        self.put("shiyu_core_evaluations", "goal_id", self.goal_id, original)

    def test_complete_requires_all_independent_evidence_and_unknown_never_becomes_success_or_zero_usage(self):
        self.collection_fixture()
        self.add_evaluation("complete_candidate")
        artifact = self.add_completed_task()
        complete = audit.collect(self.plan, expectation="complete")
        self.assertTrue(complete["completionVerified"])
        self.assertEqual(complete["status"], "complete-verified")
        self.assertEqual(complete["issues"], [])
        self.assertFalse(complete["budget"]["wholeProviderBillingComplete"])
        self.assertEqual(complete["budget"]["spent"], {"tokens": 110, "calls": 2, "effects": 1})
        for secret in (BODY, ASCII_BODY): self.assertNotIn(secret, json.dumps(complete, ensure_ascii=False))
        # A model's durable complete_candidate cannot stand in for the file.
        artifact.write_text("changed after the saved artifact receipt")
        mismatch = audit.collect(self.plan, expectation="complete")
        self.assertFalse(mismatch["completionVerified"])
        self.assertIn("TASK_COMPLETION_PROOF", [item["code"] for item in mismatch["issues"]])
        artifact.write_text(BODY)
        original = copy.deepcopy(self.evaluation)
        self.evaluation["status"] = "unknown"
        self.put("shiyu_core_evaluations", "goal_id", self.goal_id, self.evaluation)
        unknown = audit.collect(self.plan, expectation="complete")
        self.assertFalse(unknown["completionVerified"])
        self.assertEqual(unknown["control"]["evaluations"][0]["metadata"]["status"], "unknown")
        self.put("shiyu_core_evaluations", "goal_id", self.goal_id, original)
        self.binding["receipt"]["status"] = "unknown"
        self.put("shiyu_goal_bindings", "goal_id", self.goal_id, self.binding)
        self.put("shiyu_goal_commands", "goal_id", self.goal_id, self.binding["receipt"])
        unknown_command = audit.collect(self.plan, expectation="complete")
        self.assertFalse(unknown_command["completionVerified"])
        self.assertEqual(unknown_command["control"]["binding"]["metadata"]["receipt"]["status"], "unknown")
        self.reservation.update(state="unknown", observed={"tokens": None, "calls": None, "effects": None})
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE shiyu_budget_reservations SET record_json=? WHERE json_extract(record_json,'$.reservationId')='reservation-1'", (audit.canonical(self.reservation),))
        unknown_usage = audit.collect(self.plan, expectation="complete")
        self.assertFalse(unknown_usage["budget"]["allReservationsSettled"])
        self.assertEqual(unknown_usage["budget"]["held"], self.reservation["amount"])
        reservation = next(row["metadata"] for row in unknown_usage["control"]["reservations"] if row["metadata"]["reservationId"] == "reservation-1")
        self.assertIsNone(reservation["observed"]["calls"])
        self.assertFalse(unknown_usage["completionVerified"])

    def test_collect_inventory_opens_no_native_file_and_audit_uses_only_exact_frozen_session(self):
        self.collection_fixture()
        foreign = self.write_session("unapproved-session", [])
        foreign.write_bytes(b"UNAPPROVED INVALID SESSION MUST NOT BE OPENED")
        before = self.database.read_bytes()
        inventory_plan = copy.deepcopy(self.plan)
        inventory_plan.pop("requestId")
        inventory_plan["sessions"] = []
        with patch.object(audit, "stable_read", side_effect=AssertionError("Inventory must not read a native/body file")):
            inventory = audit.collect(inventory_plan, mode="inventory")
        self.assertEqual(inventory["nativeFilesRead"], 0)
        self.assertEqual(inventory["requiredSessions"], self.plan["sessions"])
        self.assertEqual(inventory["status"], "inventory-only")
        with patch.object(audit, "stable_read", wraps=audit.stable_read) as read:
            snapshot = audit.collect(self.plan)
            self.assertEqual([Path(call.args[0]) for call in read.call_args_list], [self.native_path])
        self.assertEqual(snapshot["nativeFilesRead"], 1)
        self.assertEqual(snapshot["issues"], [])
        self.assertFalse(snapshot["completionVerified"])
        self.assertEqual(self.database.read_bytes(), before)
        for secret in (BODY, ASCII_BODY):
            self.assertNotIn(secret, json.dumps([inventory, snapshot], ensure_ascii=False))
        original = self.native_path.with_name("original.zstd")
        self.native_path.rename(original)
        self.native_path.symlink_to(original)
        with self.assertRaises(audit.AuditError):
            audit.collect(self.plan)

    def test_sqlite_is_uri_readonly_authorized_and_missing_database_is_not_created(self):
        with sqlite3.connect(self.database) as db:
            db.execute("CREATE TABLE sentinel(value TEXT)")
            db.execute("INSERT INTO sentinel VALUES(?)", (BODY,))
        before = self.database.read_bytes()
        original = sqlite3.connect
        with patch.object(audit.sqlite3, "connect", wraps=original) as connect:
            self.assertEqual(audit.read_db(self.database, lambda db: db.execute("SELECT count(*) FROM sentinel").fetchone()[0]), 1)
            args, kwargs = connect.call_args
            self.assertIn("?mode=ro", args[0])
            self.assertIs(kwargs["uri"], True)
        for sql in ("UPDATE sentinel SET value='changed'", "ATTACH DATABASE ':memory:' AS extra"):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                audit.read_db(self.database, lambda db: db.execute(sql))
        missing = self.root / "missing.sqlite"
        with self.assertRaises((FileNotFoundError, audit.AuditError)):
            audit.read_db(missing, lambda db: None)
        self.assertFalse(missing.exists())
        self.assertEqual(self.database.read_bytes(), before)

    def test_native_hash_uses_exact_javascript_number_and_numeric_key_serialization(self):
        message = {"id": "message-hash-fixture", "role": "user", "content": [{"type": "text", "text": "合成 🪶"}],
                   "source": {"kind": "user"}, "10": 0.0000001, "2": 1.0}
        # JS object enumeration puts integer keys first numerically even after
        # recursive key sorting, and its finite-number formatting differs.
        expected = '{"2":1,"10":1e-7,"content":[{"text":"合成 🪶","type":"text"}],"id":"message-hash-fixture","role":"user","source":{"kind":"user"}}'
        self.assertEqual(audit.native_message_hash(message), audit.sha(expected.encode()))
        self.assertNotEqual(audit.native_message_hash(message), audit.sha(audit.canonical(message).encode()))

    def test_concatenated_native_frames_expose_hashes_and_references_without_message_or_goal_body(self):
        user = {"id": "input-1", "role": "user", "content": [{"type": "text", "text": BODY}], "source": {"kind": "user"}}
        assistant = {"id": "assistant-1", "role": "assistant", "content": [{"type": "text", "text": ASCII_BODY}]}
        native_goal = {"id": "native-goal-1", "revision": 1, "phase": "active", "activation": "disarmed",
                       "objective": BODY, "maxGoalRounds": 2}
        raw = encode([{"format": 4, "privateHeader": BODY}, {"seq": 0, "type": "user/message", "data": user}])
        raw += encode([{"seq": 1, "type": "assistant/message", "data": {"message": assistant, "private": BODY}},
                       {"seq": 2, "type": "goal/change", "data": {"goal": native_goal, "roundsStarted": 0, "reason": ASCII_BODY}}])
        result = audit.native_events(raw, self.plan["limits"])
        self.assertEqual([row["seq"] for row in result["events"]], [0, 1, 2])
        self.assertEqual(result["events"][0]["messageHash"], audit.native_message_hash(user))
        self.assertEqual(result["events"][1]["messageHash"], audit.native_message_hash(assistant))
        self.assertEqual(result["events"][1]["textSha256"], audit.sha(ASCII_BODY.encode()))
        self.assertEqual(result["events"][2]["goal"]["id"], native_goal["id"])
        self.assertEqual(result["events"][2]["goal"]["roundsStarted"], 0)
        self.assertEqual(result["eventCounts"], {"user/message": 1, "assistant/message": 1, "goal/change": 1})
        for secret in (BODY, ASCII_BODY):
            self.assertNotIn(secret, json.dumps(result, ensure_ascii=False))
        conflicting = encode([{}, {"seq": 0, "type": "goal/change", "data": {"goal": {**native_goal, "roundsStarted": 1}, "roundsStarted": 0}}])
        with self.assertRaises(audit.AuditError):
            audit.native_events(conflicting, self.plan["limits"])

    def test_native_sequence_and_decoding_limits_fail_closed(self):
        with self.assertRaises(audit.AuditError):
            audit.native_events(encode([{}, {"seq": 1, "type": "user/message", "data": {"id": "gap"}}]), self.plan["limits"])
        limits = copy.deepcopy(self.plan["limits"])
        limits["decodedSessionBytes"] = 1
        with self.assertRaises(audit.AuditError):
            audit.native_events(encode([{"format": 4, "header": BODY}]), limits)
        limits = copy.deepcopy(self.plan["limits"])
        limits["nativeEventRows"] = 1
        with self.assertRaises(audit.AuditError):
            audit.native_events(encode([{}, {"seq": 0, "type": "user/message", "data": {}},
                                        {"seq": 1, "type": "assistant/message", "data": {}}]), limits)

    def test_exclusive_snapshot_preserves_existing_evidence_and_refuses_symlink_target(self):
        output = self.root / "snapshot.json"
        audit.exclusive_json(output, {"first": True})
        with self.assertRaises(FileExistsError):
            audit.exclusive_json(output, {"first": False})
        alias = self.root / "alias.json"
        alias.symlink_to(output)
        with self.assertRaises((OSError, audit.AuditError)):
            audit.exclusive_json(alias, {"replacement": True})
        self.assertEqual(json.loads(output.read_text()), {"first": True})


if __name__ == "__main__":
    unittest.main()
