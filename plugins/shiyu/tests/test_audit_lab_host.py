"""Synthetic 3H audit fixtures; no live database, Session, host or model access."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import zstandard

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("lab_host_audit", BASE / "scripts/audit-lab-host.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
STAMP = "2026-11-02T12:00:00.000Z"
BODY = "SYNTHETIC_PRIVATE_LAB_INPUT_不得公开"
OUTPUT = "SYNTHETIC_PRIVATE_NATIVE_DRAFT_不得公开"
CLAIM = "SYNTHETIC_PRIVATE_CLAIM_TOKEN"
TARGET_TOKEN = "SYNTHETIC_PRIVATE_TARGET_TOKEN"
SECRET_REASONING = "SYNTHETIC_PRIVATE_ASSISTANT_REASONING_不得公开"
USER_SEQ = 2
ASSISTANT_SEQ = 4
SECOND_USER_SEQ = 9
SECOND_ASSISTANT_SEQ = 10


class Fixture(unittest.TestCase):
    def setUp(self):
        scratch = BASE / ".local"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="lab-audit-fixture-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.database = self.root / "control.sqlite"
        self.session_root = self.root / "sessions"
        self.session_root.mkdir()
        self.connection_id = "lab-" + "a" * 40
        self.run_id = "synthetic-run-1"
        self.channel_id = "synthetic-channel-1"
        self.conversation_id = "synthetic-conversation-1"
        self.session_id = "shiyu-replyer-" + "b" * 64
        self.plan = {
            "schemaVersion": 1, "phase": "3H", "runId": self.run_id,
            "connectionId": self.connection_id, "requestId": "synthetic-request-1",
            "executionPlanSha256": "c" * 64,
            "budget": {"tokens": 65536, "calls": 4, "effects": 4},
            "channelIds": [self.channel_id],
            "paths": {"controlDb": str(self.database), "sessionRoots": [str(self.session_root)]},
            "limits": {"inputs": 200, "replies": 8, "sends": 8, "compressedSessionBytes": 16777216,
                       "decodedSessionBytes": 67108864, "nativeEventRows": 4096},
            "sessions": [],
        }
        self.event = {"eventId": "synthetic-event-1", "channelId": self.channel_id,
            "actorId": "HUMAN", "type": "input.message", "seq": 1,
            "bodyHash": audit.sha(BODY.encode()), "bodyBytes": len(BODY.encode())}
        self.connection = {
            "connectionId": self.connection_id, "requestId": self.plan["requestId"], "runId": self.run_id,
            "version": 2, "epoch": 1, "status": "connected", "mandateId": "synthetic-mandate-1",
            "budget": self.plan["budget"], "expiresAt": "2026-11-02T13:00:00.000Z",
            "createdAt": STAMP, "updatedAt": STAMP, "hostEpoch": "synthetic-host-1",
            "installationGeneration": "synthetic-install-1",
            "channels": [{"channelId": self.channel_id, "kind": "group", "membersDigest": "d" * 64,
                          "conversationId": self.conversation_id, "inputVersion": 1, "cursor": 1,
                          "latestInput": self.event, "pendingInputs": [self.event]}],
        }
        self.mandate = {"schemaVersion": 1, "mandateId": self.connection["mandateId"],
            "scope": "local-owner", "issuer": "local-owner", "subjectIds": ["shiyu-lab-dispatcher"],
            "allowedActions": ["lab.reply", "lab.message.send"], "allowedResources": ["synthetic-lab-resource"],
            "limits": self.plan["budget"], "basisRef": "owner-lab-connect:synthetic-request-1", "state": "active",
            "version": 1, "authEpoch": 1, "validFrom": STAMP, "expiresAt": self.connection["expiresAt"],
            "maxExpiresAt": self.connection["expiresAt"], "createdAt": STAMP, "updatedAt": STAMP}
        with sqlite3.connect(self.database) as db:
            db.executescript("""
              CREATE TABLE shiyu_lab_connections(connection_id TEXT PRIMARY KEY,request_id TEXT,intent_hash TEXT,record_json TEXT);
              CREATE TABLE shiyu_lab_inputs(connection_id TEXT,event_id TEXT,channel_id TEXT,seq INTEGER,record_json TEXT);
              CREATE TABLE shiyu_lab_replies(reply_id TEXT PRIMARY KEY,connection_id TEXT,channel_id TEXT,anchor_event_id TEXT,record_json TEXT);
              CREATE TABLE shiyu_lab_sends(op_id TEXT PRIMARY KEY,connection_id TEXT,reply_id TEXT,record_json TEXT);
              CREATE TABLE shiyu_mandates(id TEXT PRIMARY KEY,intent_hash TEXT,version INTEGER,auth_epoch INTEGER,record_json TEXT);
              CREATE TABLE shiyu_budget_reservations(id TEXT PRIMARY KEY,mandate_id TEXT,intent_hash TEXT,version INTEGER,record_json TEXT);
              CREATE TABLE shiyu_budget_receipts(id TEXT PRIMARY KEY,reservation_id TEXT,receipt_hash TEXT,result_json TEXT);
              CREATE TABLE shiyu_effects(seq INTEGER PRIMARY KEY AUTOINCREMENT,effect_id TEXT UNIQUE,idempotency_key TEXT,intent_hash TEXT,status TEXT,version INTEGER,record_json TEXT);
              CREATE TABLE shiyu_effect_attempts(effect_id TEXT,attempt INTEGER,claim_token TEXT,record_json TEXT);
              CREATE TABLE shiyu_effect_receipts(receipt_id TEXT PRIMARY KEY,effect_id TEXT,claim_token TEXT,receipt_hash TEXT,record_json TEXT);
              CREATE TABLE shiyu_local_reply_inputs(operation_id TEXT PRIMARY KEY,conversation_id TEXT,input_id TEXT,input_hash TEXT,record_json TEXT);
              CREATE TABLE shiyu_reply_bindings(id TEXT PRIMARY KEY,binding_key TEXT,conversation_id TEXT,scope TEXT,record_json TEXT);
              CREATE TABLE shiyu_conversations(id TEXT PRIMARY KEY,binding_key TEXT,scope TEXT,record_json TEXT);
              CREATE TABLE shiyu_lab_conversations(connection_id TEXT,run_id TEXT,channel_id TEXT,kind TEXT,members_digest TEXT,retired INTEGER,conversation_id TEXT,topic_id TEXT,binding_id TEXT);
            """)
            db.execute("INSERT INTO shiyu_lab_connections VALUES(?,?,?,?)", (self.connection_id, self.plan["requestId"], "e" * 64, audit.canonical(self.connection)))
            db.execute("INSERT INTO shiyu_lab_inputs VALUES(?,?,?,?,?)", (self.connection_id, self.event["eventId"], self.channel_id, 1, audit.canonical(self.event)))
            db.execute("INSERT INTO shiyu_mandates VALUES(?,?,?,?,?)", (self.mandate["mandateId"], "f" * 64, 1, 1, audit.canonical(self.mandate)))

    def replace_record(self, table, key, value, record, column="record_json"):
        with sqlite3.connect(self.database) as db:
            db.execute(f'UPDATE "{table}" SET "{column}"=? WHERE "{key}"=?', (audit.canonical(record), value))

    def write_session(self, session_id, rows):
        path = self.session_root / session_id / "session.v4.jsonl.zstd"
        path.parent.mkdir(exist_ok=True)
        header = {"format": 4, "agentPreset": "shiyu-runtime-replyer-v1", "cwd": str(self.root), "privateHeader": BODY}
        raw = ("\n".join(audit.canonical(row) for row in [header] + rows) + "\n").encode()
        path.write_bytes(zstandard.ZstdCompressor().compress(raw))
        return path

    def add_unknown_reply(self):
        self.reply_id = "lab-reply-" + "1" * 40
        self.authorization = {"reservationId": "lab-generation:" + self.reply_id,
            "mandateId": self.mandate["mandateId"], "mandateVersion": 1, "authEpoch": 1,
            "scope": "local-owner", "action": "lab.reply", "resourceScopes": ["synthetic-lab-resource"]}
        self.reservation = {**self.authorization, "schemaVersion": 1, "principalId": "shiyu-lab-dispatcher",
            "amount": {"tokens": 16384, "calls": 1, "effects": 0}, "version": 2, "state": "unknown",
            "observed": {"effects": 0}, "overrun": False, "leaseExpiresAt": "2026-11-02T12:10:00.000Z",
            "createdAt": STAMP, "updatedAt": STAMP}
        self.permit = {"replyId": self.reply_id, "connectionId": self.connection_id, "connectionEpoch": 1,
            "channelId": self.channel_id, "inputVersion": 1, "anchorEventId": self.event["eventId"],
            "claimToken": CLAIM, "installationGeneration": "synthetic-install-1", "hostEpoch": "synthetic-host-1",
            "authorization": self.authorization, "leaseExpiresAt": self.reservation["leaseExpiresAt"]}
        self.reply = {"replyId": self.reply_id, "connectionId": self.connection_id, "channelId": self.channel_id,
            "conversationId": self.conversation_id, "anchorEventId": self.event["eventId"], "inputRefs": [self.event],
            "permit": self.permit, "status": "unknown", "reservation": self.reservation,
            "reasonCode": "NATIVE_UNCONFIRMED", "createdAt": STAMP}
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO shiyu_lab_replies VALUES(?,?,?,?,?)", (self.reply_id, self.connection_id, self.channel_id, self.event["eventId"], audit.canonical(self.reply)))
            db.execute("INSERT INTO shiyu_budget_reservations VALUES(?,?,?,?,?)", (self.authorization["reservationId"], self.mandate["mandateId"], "1" * 64, 2, audit.canonical(self.reservation)))
            db.execute("INSERT INTO shiyu_budget_receipts VALUES(?,?,?,?)", ("synthetic-unknown-usage", self.authorization["reservationId"], "2" * 64, audit.canonical(self.reservation)))

    def add_complete_delivery(self):
        self.add_unknown_reply()
        self.operation_id = "synthetic-draft-1"
        self.op_id = "lab-send-" + "2" * 40
        meta = {"eventId": self.event["eventId"], "actorId": self.event["actorId"], "channelId": self.channel_id, "type": self.event["type"]}
        # Native JS JSON.stringify preserves this explicit insertion order.
        envelope = "输入 1 元信息（仅数据）：" + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n正文：\n" + BODY
        prompt = "合成获准资料：{}\n本轮用户输入：\n" + envelope
        self.user = {"id": "synthetic-native-input-1", "role": "user", "source": {"kind": "user"}, "content": [{"type": "text", "text": prompt}]}
        directory_text = "Current working directory: " + json.dumps(str(self.root), ensure_ascii=False) + "."
        context = {"id": "11111111-2222-4333-8444-555555555555", "role": "user", "content": [{"type": "text", "text": "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n" + directory_text}],
                   "source": {"kind": "runtime-context", "form": "snapshot", "sections": [{"name": "working-directory:current", "text": directory_text}]}}
        self.assistant = {"id": "synthetic-native-assistant-1", "role": "assistant", "content": [{"type": "text", "text": OUTPUT}]}
        self.native_rows = [
            {"seq": 0, "type": "turn/start", "data": {"turn": 1}},
            {"seq": 1, "type": "step/start", "data": {"turn": 1, "step": 1}},
            {"seq": USER_SEQ, "type": "user/message", "data": self.user},
            {"seq": 3, "type": "user/message", "data": context},
            {"seq": ASSISTANT_SEQ, "type": "assistant/message", "data": {"turn": 1, "step": 1, "message": self.assistant, "usage": {"inputTokens": 80, "outputTokens": 20, "totalTokens": 100}, "interrupted": False}},
            {"seq": 5, "type": "step/end", "data": {"turn": 1, "step": 1}},
            {"seq": 6, "type": "turn/end", "data": {"turn": 1, "reason": {"kind": "completed"}}},
        ]
        self.native_path = self.write_session(self.session_id, self.native_rows)
        self.plan["sessions"] = [{"sessionId": self.session_id, "conversationId": self.conversation_id, "cwd": str(self.root)}]
        binding = {"operationId": self.operation_id, "contextTokenId": "synthetic-context-1", "sessionEpoch": 1,
                   "key": "synthetic-native-key", "businessId": "synthetic-business-1", "scope": "local-owner",
                   "sessionId": self.session_id, "messageId": self.user["id"], "messageHash": audit.native_message_hash(self.user)}
        self.local = {"operationId": self.operation_id, "conversationId": self.conversation_id, "inputId": self.reply_id,
                      "inputHash": audit.sha(envelope.encode()), "bindingId": "synthetic-binding-1", "businessId": binding["businessId"],
                      "scope": "local-owner", "sessionEpoch": 1, "status": "ready", "durability": "confirmed",
                      "token": {"conversationGeneration": 2}, "createdAt": STAMP, "updatedAt": STAMP,
                      "nativeBinding": binding, "contextReceipt": {**binding, "userMessageSeq": USER_SEQ, "confirmedAt": STAMP, "durability": "confirmed"},
                      "assistantRef": {"sessionId": self.session_id, "eventSeq": ASSISTANT_SEQ, "messageId": self.assistant["id"]},
                      "textSha256": audit.sha(OUTPUT.encode()), "draftId": "synthetic-draft-ref"}
        self.reservation.update(state="settled", observed={"tokens": 100, "calls": 1, "effects": 0}, version=3)
        self.reply.update(status="sent", sendId=self.op_id, reservation=copy.deepcopy(self.reservation))
        send_auth = {**self.authorization, "reservationId": "lab-send-budget:" + self.op_id, "action": "lab.message.send"}
        self.send_reservation = {**send_auth, "schemaVersion": 1, "principalId": "shiyu-lab-dispatcher",
            "amount": {"tokens": 0, "calls": 0, "effects": 1}, "observed": {"tokens": 0, "calls": 0, "effects": 1},
            "state": "settled", "version": 2, "overrun": False, "leaseExpiresAt": "2026-11-02T12:05:00.000Z", "createdAt": STAMP, "updatedAt": STAMP}
        self.observation = {"eventId": "synthetic-delivered-1", "channelId": self.channel_id, "opId": self.op_id, "bodyHash": audit.sha(OUTPUT.encode()), "observedAt": STAMP}
        self.send = {"opId": self.op_id, "connectionId": self.connection_id, "channelId": self.channel_id, "replyId": self.reply_id,
                     "draftOperationId": self.operation_id, "bodyHash": self.observation["bodyHash"], "bodyBytes": len(OUTPUT.encode()),
                     "conversationGeneration": 2, "authorization": send_auth, "observation": self.observation}
        self.claim = {"effectId": self.op_id, "attempt": 1, "claimToken": CLAIM, "ownerId": "shiyu-lab-dispatcher",
                      "hostEpoch": "synthetic-host-1", "installationGeneration": "synthetic-install-1", "fencingToken": 1,
                      "claimedAt": STAMP, "leaseExpiresAt": "2026-11-02T12:05:00.000Z"}
        self.effect = {"schemaVersion": 1, "effectId": self.op_id, "idempotencyKey": self.op_id,
                       "origin": {"kind": "dialogue", "conversationId": self.conversation_id, "turnId": self.reply_id, "conversationGeneration": 2},
                       "action": "lab.message.send", "resourceScopes": send_auth["resourceScopes"], "payloadRef": "native-draft:" + self.operation_id,
                       "payloadHash": self.observation["bodyHash"], "replayClass": "reconcilable", "authorization": {
                           "mandateId": self.mandate["mandateId"], "mandateVersion": 1, "authEpoch": 1, "installationGeneration": "synthetic-install-1"},
                       "expiresAt": self.connection["expiresAt"], "maxAttempts": 1, "status": "succeeded", "version": 3, "attempts": 1,
                       "currentClaim": self.claim, "receiptId": "synthetic-effect-receipt-1", "createdAt": STAMP, "updatedAt": STAMP}
        self.effect_receipt = {"receiptId": self.effect["receiptId"], "effectId": self.op_id, "claim": self.claim,
            "serviceId": "shiyu-lab", "externalOperationId": self.op_id, "observedAt": STAMP, "outcome": "succeeded",
            "payloadHash": self.observation["bodyHash"], "evidenceRefs": ["lab-event:" + self.observation["eventId"]], "receivedAt": STAMP, "mode": "completion",
            "verification": {"verified": True, "installationGeneration": "synthetic-install-1", "serviceId": "shiyu-lab",
                             "externalOperationId": self.op_id, "reconciled": False, "settledEffect": {
                                 "idempotencyKey": self.op_id, "payloadHash": self.observation["bodyHash"], "outcome": "succeeded"}}}
        self.connection["channels"][0]["pendingInputs"] = []
        self.plan["expectedInputs"] = [copy.deepcopy(self.event)]
        self.plan["deliveryObservations"] = [copy.deepcopy(self.observation)]
        self.delivery_evidence_path = self.root / "delivery-evidence.json"
        synthetic_source = audit.canonical({"runId": self.run_id, "type": "message.delivered", "eventId": self.observation["eventId"], "body": OUTPUT}).encode()
        self.delivery_evidence = {"schemaVersion": 1, "phase": "3H", "runId": self.run_id,
            "source": {"kind": "lab-persisted-events", "sha256": audit.sha(synthetic_source), "bytes": len(synthetic_source)},
            "observations": [copy.deepcopy(self.observation)]}
        self.delivery_evidence_path.write_text(audit.canonical(self.delivery_evidence), encoding="utf-8")
        self.plan["deliveryEvidence"] = {"path": str(self.delivery_evidence_path), "sha256": audit.sha(self.delivery_evidence_path.read_bytes())}
        self.replace_record("shiyu_lab_connections", "connection_id", self.connection_id, self.connection)
        self.replace_record("shiyu_lab_replies", "reply_id", self.reply_id, self.reply)
        self.replace_record("shiyu_budget_reservations", "id", self.reservation["reservationId"], self.reservation)
        self.replace_record("shiyu_budget_receipts", "id", "synthetic-unknown-usage", self.reservation, "result_json")
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO shiyu_local_reply_inputs VALUES(?,?,?,?,?)", (self.operation_id, self.conversation_id, self.reply_id, self.local["inputHash"], audit.canonical(self.local)))
            db.execute("INSERT INTO shiyu_lab_sends VALUES(?,?,?,?)", (self.op_id, self.connection_id, self.reply_id, audit.canonical(self.send)))
            db.execute("INSERT INTO shiyu_budget_reservations VALUES(?,?,?,?,?)", (send_auth["reservationId"], self.mandate["mandateId"], "3" * 64, 2, audit.canonical(self.send_reservation)))
            db.execute("INSERT INTO shiyu_budget_receipts VALUES(?,?,?,?)", ("synthetic-send-usage", send_auth["reservationId"], "4" * 64, audit.canonical(self.send_reservation)))
            db.execute("INSERT INTO shiyu_effects(effect_id,idempotency_key,intent_hash,status,version,record_json) VALUES(?,?,?,?,?,?)", (self.op_id, self.op_id, "5" * 64, "succeeded", 3, audit.canonical(self.effect)))
            db.execute("INSERT INTO shiyu_effect_attempts VALUES(?,?,?,?)", (self.op_id, 1, CLAIM, audit.canonical({**self.claim, "status": "succeeded", "endedAt": STAMP})))
            db.execute("INSERT INTO shiyu_effect_receipts VALUES(?,?,?,?,?)", (self.effect["receiptId"], self.op_id, CLAIM, "6" * 64, audit.canonical(self.effect_receipt)))

    def add_second_delivery_reusing_session(self):
        self.second_event = {**self.event, "eventId": "synthetic-event-2", "seq": 2}
        self.second_reply_id = "lab-reply-" + "3" * 40
        self.second_op_id = "lab-send-" + "4" * 40
        self.second_operation_id = "synthetic-draft-2"
        meta = {"eventId": self.second_event["eventId"], "actorId": self.second_event["actorId"], "channelId": self.channel_id, "type": self.second_event["type"]}
        envelope = "输入 1 元信息（仅数据）：" + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n正文：\n" + BODY
        user = {**self.user, "id": "synthetic-native-input-2", "content": [{"type": "text", "text": "合成获准资料：{}\n本轮用户输入：\n" + envelope}]}
        assistant = {**self.assistant, "id": "synthetic-native-assistant-2"}
        self.native_rows += [
            {"seq": 7, "type": "turn/start", "data": {"turn": 2}},
            {"seq": 8, "type": "step/start", "data": {"turn": 2, "step": 2}},
            {"seq": SECOND_USER_SEQ, "type": "user/message", "data": user},
            {"seq": SECOND_ASSISTANT_SEQ, "type": "assistant/message", "data": {"turn": 2, "step": 2, "message": assistant, "usage": {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120}, "interrupted": False}},
            {"seq": 11, "type": "step/end", "data": {"turn": 2, "step": 2}},
            {"seq": 12, "type": "turn/end", "data": {"turn": 2, "reason": {"kind": "completed"}}},
        ]
        self.write_session(self.session_id, self.native_rows)
        authorization = {**self.authorization, "reservationId": "lab-generation:" + self.second_reply_id}
        generation = {**self.reservation, **authorization, "observed": {"tokens": 120, "calls": 1, "effects": 0}}
        permit = {**self.permit, "replyId": self.second_reply_id, "inputVersion": 2, "anchorEventId": self.second_event["eventId"], "claimToken": CLAIM + "_SECOND", "authorization": authorization}
        reply = {**self.reply, "replyId": self.second_reply_id, "anchorEventId": self.second_event["eventId"], "inputRefs": [self.second_event], "permit": permit, "reservation": generation, "sendId": self.second_op_id}
        binding = {**self.local["nativeBinding"], "operationId": self.second_operation_id, "contextTokenId": "synthetic-context-2", "messageId": user["id"], "messageHash": audit.native_message_hash(user)}
        self.second_local = {**self.local, "operationId": self.second_operation_id, "inputId": self.second_reply_id,
            "inputHash": audit.sha(envelope.encode()), "token": {"conversationGeneration": 3}, "nativeBinding": binding,
            "contextReceipt": {**binding, "userMessageSeq": SECOND_USER_SEQ, "confirmedAt": STAMP, "durability": "confirmed"},
            "assistantRef": {"sessionId": self.session_id, "eventSeq": SECOND_ASSISTANT_SEQ, "messageId": assistant["id"]}}
        send_auth = {**authorization, "reservationId": "lab-send-budget:" + self.second_op_id, "action": "lab.message.send"}
        send_reservation = {**self.send_reservation, **send_auth}
        self.second_observation = {**self.observation, "opId": self.second_op_id, "eventId": "synthetic-delivered-2"}
        send = {**self.send, "opId": self.second_op_id, "replyId": self.second_reply_id, "draftOperationId": self.second_operation_id,
                "conversationGeneration": 3, "authorization": send_auth, "observation": self.second_observation}
        claim = {**self.claim, "effectId": self.second_op_id, "claimToken": CLAIM + "_SECOND", "fencingToken": 2}
        effect = {**self.effect, "effectId": self.second_op_id, "idempotencyKey": self.second_op_id,
                  "origin": {**self.effect["origin"], "turnId": self.second_reply_id, "conversationGeneration": 3},
                  "payloadRef": "native-draft:" + self.second_operation_id, "currentClaim": claim, "receiptId": "synthetic-effect-receipt-2"}
        receipt = {**self.effect_receipt, "receiptId": effect["receiptId"], "effectId": self.second_op_id, "claim": claim,
                   "externalOperationId": self.second_op_id, "evidenceRefs": ["lab-event:" + self.second_observation["eventId"]],
                   "verification": {**self.effect_receipt["verification"], "externalOperationId": self.second_op_id,
                       "settledEffect": {**self.effect_receipt["verification"]["settledEffect"], "idempotencyKey": self.second_op_id}}}
        self.connection["channels"][0].update(latestInput=self.second_event, inputVersion=2, cursor=2)
        self.replace_record("shiyu_lab_connections", "connection_id", self.connection_id, self.connection)
        self.plan["expectedInputs"].append(copy.deepcopy(self.second_event))
        self.plan["deliveryObservations"].append(copy.deepcopy(self.second_observation))
        self.delivery_evidence["observations"] = copy.deepcopy(self.plan["deliveryObservations"])
        self.delivery_evidence_path.write_text(audit.canonical(self.delivery_evidence), encoding="utf-8")
        self.plan["deliveryEvidence"]["sha256"] = audit.sha(self.delivery_evidence_path.read_bytes())
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO shiyu_lab_inputs VALUES(?,?,?,?,?)", (self.connection_id, self.second_event["eventId"], self.channel_id, 2, audit.canonical(self.second_event)))
            db.execute("INSERT INTO shiyu_lab_replies VALUES(?,?,?,?,?)", (self.second_reply_id, self.connection_id, self.channel_id, self.second_event["eventId"], audit.canonical(reply)))
            db.execute("INSERT INTO shiyu_local_reply_inputs VALUES(?,?,?,?,?)", (self.second_operation_id, self.conversation_id, self.second_reply_id, self.second_local["inputHash"], audit.canonical(self.second_local)))
            db.execute("INSERT INTO shiyu_lab_sends VALUES(?,?,?,?)", (self.second_op_id, self.connection_id, self.second_reply_id, audit.canonical(send)))
            for reservation, receipt_id in ((generation, "synthetic-generation-usage-2"), (send_reservation, "synthetic-send-usage-2")):
                db.execute("INSERT INTO shiyu_budget_reservations VALUES(?,?,?,?,?)", (reservation["reservationId"], self.mandate["mandateId"], "7" * 64, reservation["version"], audit.canonical(reservation)))
                db.execute("INSERT INTO shiyu_budget_receipts VALUES(?,?,?,?)", (receipt_id, reservation["reservationId"], "8" * 64, audit.canonical(reservation)))
            db.execute("INSERT INTO shiyu_effects(effect_id,idempotency_key,intent_hash,status,version,record_json) VALUES(?,?,?,?,?,?)", (self.second_op_id, self.second_op_id, "9" * 64, "succeeded", 3, audit.canonical(effect)))
            db.execute("INSERT INTO shiyu_effect_attempts VALUES(?,?,?,?)", (self.second_op_id, 1, claim["claimToken"], audit.canonical({**claim, "status": "succeeded", "endedAt": STAMP})))
            db.execute("INSERT INTO shiyu_effect_receipts VALUES(?,?,?,?,?)", (effect["receiptId"], self.second_op_id, claim["claimToken"], "a" * 64, audit.canonical(receipt)))

    def assert_redacted(self, result):
        text = json.dumps(result, ensure_ascii=False)
        for value in (BODY, OUTPUT, CLAIM, TARGET_TOKEN, SECRET_REASONING, str(self.root)):
            self.assertNotIn(value, text)
        for field in ('"claimToken"', '"targetToken"', '"token"', '"text"', '"content"'):
            self.assertNotIn(field, text)

    def assert_rejected(self, plan=None, mode="audit", expectation="observe"):
        try:
            result = audit.collect(plan or self.plan, mode, expectation)
        except audit.AuditError:
            return
        self.assertEqual(result["status"], "mismatch")
        self.assertFalse(result["completionVerified"])
        self.assert_redacted(result)

    def test_inventory_reads_only_selected_control_records_without_touching_any_native_file(self):
        # A malformed unrelated native file proves inventory is not a Session scan.
        foreign = self.session_root / "unrelated-session"
        foreign.mkdir()
        (foreign / "session.v4.jsonl.zstd").write_bytes(b"not a native Session")
        self.add_unknown_reply()
        before = self.database.read_bytes()
        result = audit.collect(self.plan, "inventory")
        self.assertEqual(result["status"], "inventory")
        self.assertEqual(result["nativeFilesRead"], 0)
        self.assertFalse(result["completionVerified"])
        self.assertEqual(result["selected"]["connectionId"], self.connection_id)
        self.assertEqual(self.database.read_bytes(), before)
        self.assert_redacted(result)

    def test_unknown_generation_preserves_held_budget_and_never_counts_as_zero_or_complete(self):
        self.add_unknown_reply()
        result = audit.collect(self.plan)
        self.assertEqual(result["status"], "consistent-incomplete")
        self.assertFalse(result["completionVerified"])
        self.assertEqual(result["selected"]["budget"]["held"], {"tokens": 16384, "calls": 1, "effects": 0})
        self.assertEqual(result["selected"]["budget"]["spent"], {"tokens": 0, "calls": 0, "effects": 0})
        self.assert_rejected(expectation="complete")
        self.assert_redacted(result)

    def test_readonly_connection_refuses_writes_and_does_not_change_control_data(self):
        before = self.database.read_bytes()
        with self.assertRaises(sqlite3.DatabaseError):
            audit.read_db(self.database, lambda db: db.execute("DELETE FROM shiyu_lab_inputs"))
        self.assertEqual(self.database.read_bytes(), before)
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM shiyu_lab_inputs").fetchone()[0], 1)

    def test_plan_identity_and_channel_scope_are_exact_not_content_similarity(self):
        for field, value in (("runId", "foreign-run"), ("connectionId", "lab-" + "9" * 40),
                             ("requestId", "foreign-request"), ("channelIds", ["foreign-channel"])):
            with self.subTest(field=field):
                plan = copy.deepcopy(self.plan)
                plan[field] = value
                self.assert_rejected(plan, "inventory")
        plan = copy.deepcopy(self.plan)
        plan["budget"]["tokens"] += 1
        self.assert_rejected(plan, "inventory")

    def test_frozen_input_metadata_detects_actor_type_hash_and_sequence_substitution(self):
        self.plan["expectedInputs"] = [copy.deepcopy(self.event)]
        for field, value in (("actorId", "OTHER"), ("type", "input.request"), ("bodyHash", "0" * 64), ("seq", 2)):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.event)
                changed[field] = value
                self.replace_record("shiyu_lab_inputs", "event_id", self.event["eventId"], changed)
                self.assert_rejected(mode="inventory")
        self.replace_record("shiyu_lab_inputs", "event_id", self.event["eventId"], self.event)

    def test_unrelated_control_rows_are_not_projected_or_needed_to_read_selected_connection(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO shiyu_lab_connections VALUES(?,?,?,?)", ("unrelated-connection", "unrelated-request", "0" * 64, "invalid unrelated json"))
            db.execute("INSERT INTO shiyu_lab_replies VALUES(?,?,?,?,?)", ("unrelated-reply", "unrelated-connection", "unrelated-channel", "other-event", "invalid unrelated json"))
        result = audit.collect(self.plan, "inventory")
        self.assertEqual(result["selected"]["connectionId"], self.connection_id)
        self.assertNotIn("unrelated-", json.dumps(result))
        self.assertEqual(result["nativeFilesRead"], 0)
        self.assert_redacted(result)

    def test_full_chain_verifies_exact_native_input_draft_effect_and_independent_delivery_metadata(self):
        self.add_complete_delivery()
        result = audit.collect(self.plan, expectation="complete")
        self.assertEqual(result["status"], "verified", result.get("issues"))
        self.assertTrue(result["completionVerified"])
        self.assertEqual(result["nativeFilesRead"], 1)
        self.assertEqual(result["selected"]["budget"]["spent"], {"tokens": 100, "calls": 1, "effects": 1})
        self.assertEqual(result["selected"]["budget"]["held"], {"tokens": 0, "calls": 0, "effects": 0})
        self.assert_redacted(result)

    def test_native_proof_rejects_wrong_message_identity_hash_sender_and_usage(self):
        self.add_complete_delivery()
        original = copy.deepcopy(self.local)
        for field, value in (("textSha256", "0" * 64), ("inputHash", "0" * 64)):
            with self.subTest(field=field):
                changed = copy.deepcopy(original)
                changed[field] = value
                self.replace_record("shiyu_local_reply_inputs", "operation_id", self.operation_id, changed)
                self.assert_rejected(expectation="complete")
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.operation_id, original)
        rows = copy.deepcopy(self.native_rows)
        rows[ASSISTANT_SEQ]["data"]["usage"]["totalTokens"] = 101
        self.write_session(self.session_id, rows)
        self.assert_rejected(expectation="complete")
        rows = copy.deepcopy(self.native_rows)
        rows[USER_SEQ]["data"]["content"][0]["text"] = rows[USER_SEQ]["data"]["content"][0]["text"].replace('"actorId":"HUMAN"', '"actorId":"OTHER"')
        self.write_session(self.session_id, rows)
        self.assert_rejected(expectation="complete")

    def test_effect_receipt_must_verify_original_claim_service_installation_and_whole_operation(self):
        self.add_complete_delivery()
        original = copy.deepcopy(self.effect_receipt)
        changes = [
            (("verification", "verified"), False),
            (("verification", "verified"), "false"),
            (("claim", "claimToken"), "FOREIGN_CLAIM"),
            (("verification", "installationGeneration"), "foreign-installation"),
            (("verification", "externalOperationId"), "foreign-operation"),
            (("verification", "settledEffect", "payloadHash"), "0" * 64),
            (("evidenceRefs",), ["lab-event:foreign-delivery"]),
        ]
        for path, value in changes:
            with self.subTest(path=path):
                changed = copy.deepcopy(original)
                target = changed
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                self.replace_record("shiyu_effect_receipts", "receipt_id", self.effect["receiptId"], changed)
                self.assert_rejected(expectation="complete")
        self.replace_record("shiyu_effect_receipts", "receipt_id", self.effect["receiptId"], original)

    def test_complete_chain_requires_binding_agreement_granted_resource_and_settlement_receipts(self):
        self.add_complete_delivery()
        changed = copy.deepcopy(self.local)
        changed["nativeBinding"]["messageHash"] = "0" * 64
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.operation_id, changed)
        self.assert_rejected(expectation="complete")
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.operation_id, self.local)
        changed = copy.deepcopy(self.mandate)
        changed["allowedResources"] = ["foreign-resource"]
        self.replace_record("shiyu_mandates", "id", self.mandate["mandateId"], changed)
        self.assert_rejected(expectation="complete")
        self.replace_record("shiyu_mandates", "id", self.mandate["mandateId"], self.mandate)
        with sqlite3.connect(self.database) as db:
            db.execute("DELETE FROM shiyu_budget_receipts")
        self.assert_rejected(expectation="complete")

    def test_extra_or_substituted_session_is_rejected_before_unrelated_body_can_enter_report(self):
        self.add_complete_delivery()
        foreign = "unrelated-session"
        self.write_session(foreign, [{"seq": 0, "type": "user/message", "data": {"id": "foreign", "role": "user", "content": [{"type": "text", "text": TARGET_TOKEN}]}}])
        plan = copy.deepcopy(self.plan)
        plan["sessions"].append({"sessionId": foreign, "conversationId": self.conversation_id, "cwd": str(self.root)})
        self.assert_rejected(plan)
        plan = copy.deepcopy(self.plan)
        plan["sessions"][0]["sessionId"] = foreign
        self.assert_rejected(plan)

    def test_pause_reload_baseline_allows_control_fence_but_forbids_new_native_work(self):
        self.add_complete_delivery()
        baseline = audit.collect(self.plan, expectation="complete")
        self.assertTrue(baseline["completionVerified"])
        baseline_path = self.root / "baseline.json"
        baseline_path.write_text(audit.canonical(baseline), encoding="utf-8")
        self.plan["baseline"] = {"path": str(baseline_path), "sha256": audit.sha(baseline_path.read_bytes())}
        self.connection.update(status="paused", epoch=2, version=3)
        self.mandate.update(state="suspended", version=2, authEpoch=2)
        self.replace_record("shiyu_lab_connections", "connection_id", self.connection_id, self.connection)
        self.replace_record("shiyu_mandates", "id", self.mandate["mandateId"], self.mandate)
        paused = audit.collect(self.plan, expectation="complete")
        self.assertEqual(paused["status"], "verified", paused.get("issues"))
        self.assertTrue(paused["completionVerified"])
        self.assertEqual(paused["nativeFilesRead"], 1)
        self.assertEqual(paused["selected"]["replyIds"], baseline["selected"]["replyIds"])
        self.assertEqual(paused["selected"]["sendIds"], baseline["selected"]["sendIds"])
        self.assert_redacted(paused)
        rows = copy.deepcopy(self.native_rows)
        rows.append({"seq": 7, "type": "turn/start", "data": {"turn": 2}})
        self.write_session(self.session_id, rows)
        self.assert_rejected(expectation="complete")

    def test_full_delivery_requires_frozen_external_metadata_hash_and_exact_run_scope(self):
        self.add_complete_delivery()
        original_plan = copy.deepcopy(self.plan)
        self.plan.pop("deliveryEvidence")
        self.assert_rejected(expectation="complete")
        self.plan = copy.deepcopy(original_plan)
        self.delivery_evidence_path.write_text(audit.canonical({**self.delivery_evidence, "runId": "foreign-run"}), encoding="utf-8")
        self.assert_rejected(expectation="complete")  # Frozen file hash changed.
        self.plan["deliveryEvidence"]["sha256"] = audit.sha(self.delivery_evidence_path.read_bytes())
        self.assert_rejected(expectation="complete")  # New hash cannot authorize another run.
        self.delivery_evidence_path.write_text(audit.canonical(self.delivery_evidence), encoding="utf-8")
        self.plan = original_plan
        self.plan["deliveryObservations"][0]["eventId"] = "foreign-event"
        self.assert_rejected(expectation="complete")

    def test_unlinked_native_message_after_valid_draft_prevents_complete_audit(self):
        self.add_complete_delivery()
        variants = [
            [
                {"seq": 7, "type": "assistant/message", "data": {"turn": 2, "step": 2, "message": {"id": "unlinked-assistant", "role": "assistant", "content": [{"type": "text", "text": OUTPUT}]}, "usage": {"totalTokens": 7}}},
                {"seq": 8, "type": "turn/end", "data": {"turn": 2, "reason": {"kind": "completed"}}},
            ],
            [{"seq": 7, "type": "user/message", "data": {"id": "unlinked-user", "role": "user", "source": {"kind": "user"}, "content": [{"type": "text", "text": BODY}]}}],
        ]
        for tail in variants:
            with self.subTest(kind=tail[0]["type"]):
                self.write_session(self.session_id, copy.deepcopy(self.native_rows) + tail)
                result = audit.collect(self.plan, expectation="complete")
                self.assertFalse(result["completionVerified"])
                self.assertEqual(result["status"], "mismatch")
                self.assertIn("COMPLETION_UNPROVEN", [issue["code"] for issue in result["issues"]])
                self.assertFalse(result["checks"]["nativeMessageCoverageComplete"])
                self.assertGreater(result["checks"]["unlinkedNativeMessageCount"], 0)
                self.assert_redacted(result)

    def test_known_assistant_reasoning_preserves_text_proof_and_changes_full_native_hash_without_leaking(self):
        self.add_complete_delivery()
        original_hash = audit.native_message_hash(self.assistant)
        variants = [
            [{"type": "reasoning", "text": SECRET_REASONING}, {"type": "text", "text": OUTPUT}],
            [{"type": "reasoning", "text": SECRET_REASONING}, {"type": "text", "text": OUTPUT}, {"type": "reasoning", "text": SECRET_REASONING + "_SECOND"}],
        ]
        for parts in variants:
            with self.subTest(parts=len(parts)):
                rows = copy.deepcopy(self.native_rows)
                rows[ASSISTANT_SEQ]["data"]["message"]["content"] = parts
                self.write_session(self.session_id, rows)
                result = audit.collect(self.plan, expectation="complete")
                self.assertEqual(result["status"], "verified", result.get("issues"))
                self.assertTrue(result["completionVerified"])
                message = next(event for event in result["native"][0]["events"] if event["seq"] == ASSISTANT_SEQ)
                self.assertEqual(message["textSha256"], audit.sha(OUTPUT.encode()))
                self.assertNotEqual(message["messageHash"], original_hash)
                self.assertEqual(message["messageHash"], audit.native_message_hash(rows[ASSISTANT_SEQ]["data"]["message"]))
                self.assert_redacted(result)

    def test_reasoning_is_not_user_input_or_a_standalone_draft_and_unknown_assistant_blocks_are_rejected(self):
        self.add_complete_delivery()
        rows = copy.deepcopy(self.native_rows)
        rows[USER_SEQ]["data"]["content"].insert(0, {"type": "reasoning", "text": SECRET_REASONING})
        local = copy.deepcopy(self.local)
        changed_hash = audit.native_message_hash(rows[USER_SEQ]["data"])
        local["nativeBinding"]["messageHash"] = changed_hash
        local["contextReceipt"]["messageHash"] = changed_hash
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.operation_id, local)
        self.write_session(self.session_id, rows)
        self.assert_rejected(expectation="complete")
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.operation_id, self.local)
        for parts in ([{"type": "text", "text": OUTPUT}, {"type": "unknown-block", "text": SECRET_REASONING}],
                      [{"type": "reasoning", "text": SECRET_REASONING}]):
            with self.subTest(kind=parts[-1]["type"]):
                rows = copy.deepcopy(self.native_rows)
                rows[ASSISTANT_SEQ]["data"]["message"]["content"] = parts
                self.write_session(self.session_id, rows)
                self.assert_rejected(expectation="complete")

    def test_two_rounds_reuse_exact_session_and_retained_cwd_but_not_other_round_assistant_or_usage(self):
        self.add_complete_delivery()
        self.add_second_delivery_reusing_session()
        result = audit.collect(self.plan, expectation="complete")
        self.assertEqual(result["status"], "verified", result.get("issues"))
        self.assertTrue(result["completionVerified"])
        self.assertEqual(result["nativeFilesRead"], 1)
        self.assertEqual(result["native"][0]["eventCounts"]["user/message"], 3)
        self.assertEqual(result["selected"]["budget"]["spent"], {"tokens": 220, "calls": 2, "effects": 2})
        self.assert_redacted(result)
        changed = copy.deepcopy(self.second_local)
        changed["assistantRef"] = copy.deepcopy(self.local["assistantRef"])
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.second_operation_id, changed)
        self.assert_rejected(expectation="complete")
        self.replace_record("shiyu_local_reply_inputs", "operation_id", self.second_operation_id, self.second_local)
        rows = copy.deepcopy(self.native_rows)
        rows[SECOND_ASSISTANT_SEQ]["data"]["usage"]["totalTokens"] = 100
        self.write_session(self.session_id, rows)
        self.assert_rejected(expectation="complete")

    def test_independent_delivery_event_id_cannot_be_reused_by_another_operation(self):
        self.add_complete_delivery()
        self.add_second_delivery_reusing_session()
        reused = self.plan["deliveryObservations"][0]["eventId"]
        self.plan["deliveryObservations"][1]["eventId"] = reused
        # Keep every other link self-consistent so uniqueness, not a simpler
        # control/evidence disagreement, must reject the reused remote event.
        with sqlite3.connect(self.database) as db:
            send = json.loads(db.execute("SELECT record_json FROM shiyu_lab_sends WHERE op_id=?", (self.second_op_id,)).fetchone()[0])
            send["observation"]["eventId"] = reused
            db.execute("UPDATE shiyu_lab_sends SET record_json=? WHERE op_id=?", (audit.canonical(send), self.second_op_id))
            receipt = json.loads(db.execute("SELECT record_json FROM shiyu_effect_receipts WHERE effect_id=?", (self.second_op_id,)).fetchone()[0])
            receipt["evidenceRefs"] = ["lab-event:" + reused]
            db.execute("UPDATE shiyu_effect_receipts SET record_json=? WHERE effect_id=?", (audit.canonical(receipt), self.second_op_id))
        self.delivery_evidence["observations"] = copy.deepcopy(self.plan["deliveryObservations"])
        self.delivery_evidence_path.write_text(audit.canonical(self.delivery_evidence), encoding="utf-8")
        self.plan["deliveryEvidence"]["sha256"] = audit.sha(self.delivery_evidence_path.read_bytes())
        self.assert_rejected(expectation="complete")

    def test_extra_native_turn_with_step_and_error_without_assistant_is_not_complete(self):
        self.add_complete_delivery()
        rows = copy.deepcopy(self.native_rows) + [
            {"seq": 7, "type": "turn/start", "data": {"turn": 2}},
            {"seq": 8, "type": "step/start", "data": {"turn": 2, "step": 2}},
            {"seq": 9, "type": "turn/end", "data": {"turn": 2, "reason": {"kind": "error"}}},
        ]
        self.write_session(self.session_id, rows)
        result = audit.collect(self.plan, expectation="complete")
        self.assertFalse(result["completionVerified"])
        self.assertEqual(result["status"], "mismatch")
        self.assertIn("COMPLETION_UNPROVEN", [issue["code"] for issue in result["issues"]])
        self.assertFalse(result["checks"]["nativeMessageCoverageComplete"])
        self.assert_redacted(result)

    def test_official_lifecycle_requires_matching_assistant_turn_and_step_pairs_not_only_event_counts(self):
        self.add_complete_delivery()
        for index, field, value in ((ASSISTANT_SEQ, "turn", 2), (5, "step", 2)):
            with self.subTest(event=index, field=field):
                rows = copy.deepcopy(self.native_rows)
                rows[index]["data"][field] = value
                self.write_session(self.session_id, rows)
                self.assert_rejected(expectation="complete")

    def test_symlink_database_and_unbounded_plan_limits_fail_before_reading_native_files(self):
        alias = self.root / "alias.sqlite"
        alias.symlink_to(self.database)
        plan = copy.deepcopy(self.plan)
        plan["paths"]["controlDb"] = str(alias)
        self.assert_rejected(plan, "inventory")
        plan = copy.deepcopy(self.plan)
        plan["limits"]["nativeEventRows"] = 4097
        self.assert_rejected(plan, "inventory")


if __name__ == "__main__":
    unittest.main()
