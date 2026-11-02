"""Explicit-scope, read-only 3G audit. No product imports, RPC, model or UI.

Inventory reads only one selected Goal's control records. Audit additionally
reads only the exact frozen Session IDs and fixed note.txt artifacts. Node is
used solely for the product's JSON/localeCompare hash encoding, not DSH APIs.
Output is digest/metadata only, exclusively created and never overwritten.
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
import subprocess
import sys
import time
from urllib.parse import quote

MAX_JSON = 8 * 1024 * 1024
MAX_ROWS = 256
AXES = ("tokens", "calls", "effects")


class AuditError(Exception):
    """Fixed codes only; raw database or native content never enters errors."""


def require(condition, code):
    if not condition:
        raise AuditError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def exact_path(path, directory=False):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, "UNSAFE_PATH")
    mode = path.lstat().st_mode
    require(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), "NOT_REGULAR")
    return path


def stable_read(path, limit=MAX_JSON):
    path = exact_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, "FILE_BOUND")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        after = os.fstat(fd)
        require(len(raw) <= limit and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "FILE_CHANGED")
        return raw, {"bytes": len(raw), "sha256": sha(raw), "mtimeNs": str(after.st_mtime_ns)}
    finally:
        os.close(fd)


def exclusive_json(path, value):
    path = Path(path)
    require(path.is_absolute(), "OUTPUT_PATH")
    exact_path(path.parent, directory=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def read_db(path, callback):
    path = exact_path(path)
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


# Match nativeMessageHash exactly, including JS number encoding and localeCompare
# key order. No product/host modules, filenames, environment or body on argv.
HASH_JS = """import {createHash} from 'node:crypto';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const values=JSON.parse(raw),hash=x=>createHash('sha256').update(x,'utf8').digest('hex');
const encode=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)
?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
process.stdout.write(JSON.stringify(values.map(value=>hash(encode(value)))));"""


def native_hashes(values):
    require(len(values) <= 4096, "HASH_ROWS")
    raw = canonical(values).encode()
    require(len(raw) <= 64 * 1024 * 1024, "HASH_BOUND")
    result = subprocess.run(["node", "--input-type=module", "-e", HASH_JS], input=raw,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 300000, "CANONICALIZER_FAILED")
    hashes = json.loads(result.stdout)
    require(isinstance(hashes, list) and len(hashes) == len(values)
            and all(isinstance(v, str) and re.fullmatch(r"[a-f0-9]{64}", v) for v in hashes), "CANONICALIZER_OUTPUT")
    return hashes


def native_message_hash(message):
    return native_hashes([message])[0]


def safe_id(value, pattern=r"[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}"):
    require(isinstance(value, str) and re.fullmatch(pattern, value), "INVALID_ID")
    return value


def validate_plan(plan, mode):
    require(isinstance(plan, dict) and plan.get("schemaVersion") == 1 and plan.get("phase") == "3G", "PLAN_SCHEMA")
    safe_id(plan.get("runId")); safe_id(plan.get("goalId"), r"core-[a-f0-9]{40}")
    for field in ("executionPlanSha256", "objectiveSha256"):
        safe_id(plan.get(field), r"[a-f0-9]{64}")
    if mode == "audit" or plan.get("requestId") is not None:
        safe_id(plan.get("requestId"))
    require(plan.get("maxEvaluations") == 2 and plan.get("budget") == {"tokens": 65536, "calls": 6, "effects": 1}, "PLAN_BUDGET")
    require(isinstance(plan.get("deliverables"), list) and len(plan["deliverables"]) == 1, "PLAN_DELIVERABLES")
    for item in plan["deliverables"]:
        safe_id(item.get("id"), r"[A-Za-z0-9_-]{1,80}"); safe_id(item.get("sha256"), r"[a-f0-9]{64}")
        require(type(item.get("bytes")) is int and 1 <= item["bytes"] <= 1024, "PLAN_BODY_BOUND")
    limits = plan.get("limits", {})
    require(limits.get("coreRounds") == 2 and limits.get("workers") == 1, "PLAN_SCOPE_BOUND")
    for key, cap in (("compressedSessionBytes", 16 * 1024 * 1024), ("decodedSessionBytes", 64 * 1024 * 1024), ("nativeEventRows", 4096)):
        require(type(limits.get(key)) is int and 1 <= limits[key] <= cap, "PLAN_READ_BOUND")
    paths = plan.get("paths", {})
    require(set(paths) == {"controlDb", "sessionRoots", "workspaceRoot"}, "PLAN_PATHS")
    exact_path(paths["controlDb"]); exact_path(paths["workspaceRoot"], directory=True)
    roots = paths["sessionRoots"]
    require(isinstance(roots, list) and 1 <= len(roots) <= 4 and len(set(roots)) == len(roots), "PLAN_ROOTS")
    for root in roots:
        exact_path(root, directory=True)
    sessions = plan.get("sessions", [])
    require(isinstance(sessions, list) and len(sessions) <= 2, "PLAN_SESSION_BOUND")
    require(len({s.get("sessionId") for s in sessions}) == len(sessions), "PLAN_DUPLICATE_SESSION")
    for session in sessions:
        require(session.get("role") in ("core", "worker"), "PLAN_SESSION_ROLE")
        safe_id(session.get("sessionId"), r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}")
        require(set(session) == ({"role", "sessionId"} if session["role"] == "core" else {"role", "sessionId", "taskId", "assignmentId"}), "PLAN_SESSION_FIELDS")
        if session["role"] == "worker":
            safe_id(session["taskId"], r"[a-f0-9]{32}"); safe_id(session["assignmentId"])


# Explicit projections, never a recursive dump of an arbitrary JSON record.
KEYS = set("""schemaVersion goalId requestId version authorized paused cancelled controlEpoch mandateId
maxEvaluations evaluations activeEvaluationId nextEligibleAt expiresAt createdAt updatedAt completionCriteriaHash
goalRef id revision sessionId phase observedAt metadataVersion ownerId scope receipt commandId operation status
expectedRef observedRef postconditionHash completionProof verifierId verifiedAt taskRefs taskId deliverableId
evaluationId permit fencingToken hostEpoch installationGeneration scopeVersion reservationId mandateVersion
authEpoch leaseExpiresAt tasks state effectVersions effectId triggerRefs reservation candidate kind receipt
proposalId nativeReceipt dispatch roundId messageId messageHash inputRef assistantRef outputHash eventSeq durability
limits amount observed tokens calls effects overrun principalId action resourceScopes subjectIds allowedActions
allowedResources issuer policyVersion validFrom maxExpiresAt assignmentId terminal ready verification result
resultHash artifactRefs effectRefs completionSpecVersion verifierVersion checks checkId attempts currentClaim
attempt ownerId claimedAt receiptId payloadHash payloadRef idempotencyKey origin authorization replayClass
maxAttempts receivedAt outcome serviceId externalOperationId mode reconciled settledEffect matched
observedSha256 observedBytes artifactRef expectedSha256 byteLength usage nativeObservations type seq
cacheReadTokens cacheWriteTokens inputTokens outputTokens totalTokens complete state count consumedBy factId observation accounting
taskVersion eventId inputRefs requestScope at stopped unknown callCount""".split())


def projected(value):
    if isinstance(value, dict):
        return {k: projected(v) for k, v in value.items() if k in KEYS}
    if isinstance(value, list):
        require(len(value) <= MAX_ROWS, "PROJECTION_BOUND")
        return [projected(v) for v in value]
    if isinstance(value, str):
        return value if re.fullmatch(r"[A-Za-z0-9:._/+\-]{0,300}", value) else {"redactedSha256": sha(value.encode())}
    require(value is None or type(value) in (bool, int, float), "PROJECTION_VALUE")
    return value


def record(value):
    return {"recordSha256": sha(canonical(value).encode()), "metadata": projected(value)}


def control_records(plan):
    def query(db):
        def rows(sql, args=()):
            values = db.execute(sql, args).fetchmany(MAX_ROWS + 1)
            require(len(values) <= MAX_ROWS, "CONTROL_ROW_BOUND")
            return [dict(v) for v in values]
        def records(table, key, value, column="value"):
            return [json.loads(row[column]) for row in rows(f'SELECT "{column}" FROM "{table}" WHERE "{key}"=? ORDER BY rowid', (value,))]
        def one(table, key, value, column="value", optional=False):
            found = records(table, key, value, column)
            require(len(found) == 1 or optional and not found, "CONTROL_RECORD_MISSING")
            return found[0] if found else None
        gid = plan["goalId"]
        goal = one("shiyu_core_goals", "goal_id", gid)
        require(goal["goalId"] == gid and sha(goal["objective"].encode()) == plan["objectiveSha256"], "GOAL_IDENTITY")
        require(plan.get("requestId") is None or goal["requestId"] == plan["requestId"], "GOAL_REQUEST")
        require(goal["budget"] == plan["budget"] and goal["maxEvaluations"] == plan["maxEvaluations"], "GOAL_BUDGET")
        expected = [{"id": x["id"], "sha256": sha(x["content"].encode()), "bytes": len(x["content"].encode())} for x in goal["deliverables"]]
        require(expected == plan["deliverables"], "GOAL_DELIVERABLES")
        binding = one("shiyu_goal_bindings", "goal_id", gid, optional=True)
        commands = records("shiyu_goal_commands", "goal_id", gid)
        evaluations = records("shiyu_core_evaluations", "goal_id", gid)
        facts = [{"factId": row["fact_id"], "consumedBy": row["consumed_by"], **json.loads(row["value"])}
                 for row in rows('SELECT fact_id,consumed_by,value FROM shiyu_core_facts WHERE goal_id=? ORDER BY rowid', (gid,))]
        mandate = one("shiyu_mandates", "id", goal["mandateId"], "record_json") if goal.get("mandateId") else None
        reservations = records("shiyu_budget_reservations", "mandate_id", goal["mandateId"], "record_json") if mandate else []
        budget_receipts = []
        for reservation in reservations:
            budget_receipts.extend(records("shiyu_budget_receipts", "reservation_id", reservation["reservationId"], "result_json"))
        tasks = []
        for ref in goal["taskRefs"]:
            tid = safe_id(ref["taskId"], r"[a-f0-9]{32}")
            local = one("shiyu_task_local_inputs", "task_id", tid)
            task = one("shiyu_task_record", "id", tid)
            runs = records("shiyu_task_runs", "task_id", tid)
            effects = [json.loads(row["record_json"]) for row in rows("SELECT record_json FROM shiyu_effects WHERE json_extract(record_json,'$.origin.kind')='task' AND json_extract(record_json,'$.origin.taskId')=? ORDER BY seq", (tid,))]
            receipts, observations, attempts, usage = [], [], [], []
            for effect in effects:
                receipts.extend(records("shiyu_effect_receipts", "effect_id", effect["effectId"], "record_json"))
                observations.extend(records("shiyu_task_artifact_observations", "effect_id", effect["effectId"]))
                attempts.extend(records("shiyu_effect_attempts", "effect_id", effect["effectId"], "record_json"))
            for run in runs:
                usage.extend(records("shiyu_task_usage_observations", "reservation_id", run["reservationId"]))
            tasks.append({"ref": ref, "local": local, "task": task, "runs": runs, "effects": effects,
                          "receipts": receipts, "observations": observations, "attempts": attempts, "usage": usage})
        events = []
        for fact in facts:
            if fact.get("eventId"):
                events.append(one("events", "event_id", fact["eventId"], "envelope"))
        return {"goal": goal, "binding": binding, "commands": commands, "evaluations": evaluations,
                "facts": facts, "mandate": mandate, "reservations": reservations, "budgetReceipts": budget_receipts,
                "tasks": tasks, "events": events}
    return read_db(plan["paths"]["controlDb"], query)


def cwd_digest(value):
    # Cwd is inspected only in memory; reports contain no directory plaintext.
    return sha(value.encode()) if isinstance(value, str) and value.startswith("/") and "\0" not in value else None


def expected_cwd_message(message_id, cwd):
    directory = "Current working directory: " + json.dumps(cwd, ensure_ascii=False, separators=(",", ":")) + "."
    return {"id": message_id, "role": "user", "content": [{"type": "text", "text":
        "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n" + directory}],
        "source": {"kind": "runtime-context", "form": "snapshot", "sections": [{"name": "working-directory:current", "text": directory}]}}


def native_events(raw, limits, bound_cwd=None):
    import zstandard
    with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw), read_across_frames=True) as reader:
        decoded = reader.read(limits["decodedSessionBytes"] + 1)
    require(len(decoded) <= limits["decodedSessionBytes"], "NATIVE_DECODE_BOUND")
    lines = decoded.splitlines()
    require(1 <= len(lines) <= limits["nativeEventRows"] + 1, "NATIVE_ROW_BOUND")
    events, messages, message_rows, counts = [], [], [], Counter()
    expected_contexts, context_rows = [], []
    require(len(lines[0]) <= MAX_JSON and isinstance(json.loads(lines[0]), dict) and "seq" not in json.loads(lines[0]), "NATIVE_HEADER")
    header = json.loads(lines[0])
    for line in lines[1:]:
        require(len(line) <= MAX_JSON, "NATIVE_LINE_BOUND")
        value = json.loads(line)
        require(isinstance(value, dict) and type(value.get("seq")) is int and value["seq"] == len(events), "NATIVE_SEQUENCE")
        kind = safe_id(value.get("type"), r"[A-Za-z0-9_/.-]{1,120}")
        item = {"seq": value["seq"], "type": kind, "eventHash": sha(line)}
        data = value.get("data")
        message = data if kind == "user/message" else data.get("message") if kind == "assistant/message" and isinstance(data, dict) else None
        if isinstance(message, dict):
            item["messageId"] = safe_id(message.get("id"))
            item["messageRole"] = message.get("role") if message.get("role") in ("user", "assistant") else "other"
            source_kind = message.get("source", {}).get("kind") if isinstance(message.get("source"), dict) else None
            item["sourceKind"] = source_kind if source_kind in ("user", "runtime-context") else "other"
            parts = message.get("content", [])
            text = "\n".join(p["text"] for p in parts if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str))
            item["textSha256"] = sha(text.encode())
            item["interrupted"] = bool(data.get("interrupted")) if kind == "assistant/message" else False
            messages.append(message); message_rows.append(item)
            if kind == "user/message" and source_kind == "runtime-context":
                item["runtimeContextValidBoundCwd"] = False
                official_id = re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", item["messageId"], re.I)
                if official_id and cwd_digest(bound_cwd):
                    expected_contexts.append(expected_cwd_message(item["messageId"], bound_cwd)); context_rows.append(item)
        if kind == "working-directory/change":
            # Fixed dsh-working-directory 0.2.1-rc.5: header.cwd seeds the
            # projection; change data is exactly {cwd}, never path/current.
            item["cwdSha256"] = cwd_digest(data.get("cwd")) if isinstance(data, dict) and set(data) == {"cwd"} else None
        if kind == "goal/change" and isinstance(data, dict) and isinstance(data.get("goal"), dict):
            goal = data["goal"]
            item["goal"] = {key: goal[key] for key in ("id", "revision", "phase", "roundsStarted", "maxGoalRounds") if key in goal}
            # The installed host persists the driver counter on event.data,
            # separately from Goal state. Older synthetic fixtures put it on
            # goal; accepting that fixture shape must not hide a disagreement.
            if "roundsStarted" in data:
                require("roundsStarted" not in goal or goal["roundsStarted"] == data["roundsStarted"], "NATIVE_GOAL_COUNTER_CONFLICT")
                require(type(data["roundsStarted"]) is int and data["roundsStarted"] >= 0, "NATIVE_GOAL_COUNTER")
                item["goal"]["roundsStarted"] = data["roundsStarted"]
            if isinstance(goal.get("objective"), str): item["goal"]["objectiveSha256"] = sha(goal["objective"].encode())
        if isinstance(data, dict) and isinstance(data.get("usage"), dict):
            item["usage"] = {k: v for k, v in data["usage"].items() if k in ("inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens") and type(v) in (int, float)}
        events.append(item); counts[kind] += 1
    for item, value in zip(message_rows, native_hashes(messages)):
        item["messageHash"] = value
    for item, expected_hash in zip(context_rows, native_hashes(expected_contexts)):
        item["runtimeContextExpectedHash"] = expected_hash
        item["runtimeContextValidBoundCwd"] = item["messageHash"] == expected_hash
    return {"headerHash": sha(lines[0]), "headerCwdSha256": cwd_digest(header.get("cwd")),
            "events": events, "eventCounts": dict(sorted(counts.items())),
            "decodedBytes": len(decoded), "decodedRows": len(lines), "messageBodyIncluded": False}


def native_input_window(core, receipt, bound_cwd):
    """Inspect the entire committed input interval, never just matching endpoints.

    Zero new cwd messages is proven only by a preceding exact retained snapshot.
    This is an independent file proof, not an invented control-store receipt.
    """
    result = {"nativeCwdContextVerified": False, "controlContextReceiptAvailable": False,
              "userMessageSeqs": [], "runtimeContextSeq": None, "runtimeContextReused": False}
    if not core or not cwd_digest(bound_cwd):
        return result
    first, last = receipt["inputRef"].get("eventSeq"), receipt["assistantRef"].get("eventSeq")
    events, expected_cwd = core["events"], cwd_digest(bound_cwd)
    if type(first) is not int or type(last) is not int or not 0 <= first < last < len(events):
        return result
    window = events[first:last + 1]
    inputs = [e for e in window if e["type"] == "user/message"]
    result["userMessageSeqs"] = [e["seq"] for e in inputs]
    if not 1 <= len(inputs) <= 2 or inputs[0]["seq"] != first or inputs[0].get("sourceKind") != "user" or inputs[0].get("messageRole") != "user":
        return result
    # A second assistant/attempt would make this more than the one admitted call.
    if [e["seq"] for e in window if e["type"] == "assistant/message"] != [last] or any(e["type"] == "assistant/attempt" or e["type"].startswith("compaction/") or e["type"] == "session/title-llm-request" for e in window):
        return result
    current_cwd = core.get("headerCwdSha256")
    for event in events[:first + 1]:
        if event["type"] == "working-directory/change": current_cwd = event.get("cwdSha256")
    if current_cwd != expected_cwd or any(e.get("cwdSha256") != expected_cwd for e in window if e["type"] == "working-directory/change"):
        return result
    if len(inputs) == 2:
        context = inputs[1]
    else:
        contexts = [e for e in events[:first] if e["type"] == "user/message" and e.get("sourceKind") == "runtime-context"]
        context = contexts[-1] if contexts else None
        result["runtimeContextReused"] = context is not None
    if not context or not context.get("runtimeContextValidBoundCwd") or context.get("messageHash") != context.get("runtimeContextExpectedHash") or context.get("messageId") == inputs[0].get("messageId"):
        return result
    if any(e.get("cwdSha256") != expected_cwd for e in events[context["seq"]:last + 1] if e["type"] == "working-directory/change"):
        return result
    result.update(nativeCwdContextVerified=True, runtimeContextSeq=context["seq"],
                  runtimeContextMessageHash=context["messageHash"], boundCwdSha256=expected_cwd)
    return result


def collect(plan, mode="audit", expectation="observe"):
    require(mode in ("inventory", "audit") and expectation in ("observe", "complete"), "AUDIT_MODE")
    validate_plan(plan, mode)
    control = control_records(plan)
    goal, binding, evaluations = control["goal"], control["binding"], control["evaluations"]
    require(len(evaluations) <= plan["limits"]["coreRounds"] and len(control["tasks"]) <= 1, "EXECUTION_SCOPE_EXCEEDED")
    issues = []
    def check(ok, code, identity=None):
        if not ok:
            issues.append({"code": code, **({"ref": safe_id(identity)} if identity else {})})
        return bool(ok)
    required = []
    if binding:
        require(binding.get("goalId") == goal["goalId"] and binding.get("ownerId") == "local-owner" and binding.get("scope") == "local-owner"
                and binding.get("completionCriteriaHash") == goal["completionCriteriaHash"], "BINDING_SCOPE")
        require(binding.get("receipt") in control["commands"], "BINDING_JOURNAL")
        required.append({"role": "core", "sessionId": safe_id(binding["sessionId"], r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}")})
        if goal.get("native"):
            check(goal["native"]["sessionId"] == binding["sessionId"] and goal["native"]["goalRef"] == binding.get("goalRef"), "NATIVE_BINDING_MISMATCH")
    for task in control["tasks"]:
        tid, local = task["ref"]["taskId"], task["local"]
        require(task["task"].get("goalId") == goal["goalId"] and local.get("delegation", {}).get("goalId") == goal["goalId"], "TASK_SCOPE")
        require(local["mandateId"] == goal.get("mandateId") == task["task"]["mandateId"], "TASK_MANDATE")
        expected = next((x for x in plan["deliverables"] if x["id"] == task["ref"]["deliverableId"]), None)
        require(expected and local["expectedSha256"] == expected["sha256"] and local["byteLength"] == expected["bytes"]
                and sha(local["content"].encode()) == expected["sha256"], "TASK_CONTENT")
        for run in task["runs"]:
            require(run["taskId"] == tid, "ASSIGNMENT_SCOPE")
            if run.get("sessionId"):
                required.append({"role": "worker", "sessionId": safe_id(run["sessionId"], r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}"),
                                 "taskId": tid, "assignmentId": safe_id(run["assignmentId"])})
    require(len([s for s in required if s["role"] == "worker"]) <= plan["limits"]["workers"], "WORKER_SCOPE_EXCEEDED")
    require(len({s["sessionId"] for s in required}) == len(required), "SESSION_IDENTITY_COLLISION")
    reservations = {r["reservationId"]: r for r in control["reservations"]}
    known = {e["permit"]["reservationId"] for e in evaluations} | {r["reservationId"] for t in control["tasks"] for r in t["runs"]}
    check(set(reservations) == known, "RESERVATION_COVERAGE")
    spent, held = dict.fromkeys(AXES, 0), dict.fromkeys(AXES, 0)
    for reservation in reservations.values():
        require(reservation["mandateId"] == goal.get("mandateId") and reservation["scope"] == "local-owner", "RESERVATION_SCOPE")
        require(reservation["state"] in ("reserved", "settled", "unknown"), "RESERVATION_STATE")
        for axis in AXES:
            observed = reservation["observed"].get(axis)
            if reservation["state"] == "settled":
                require(type(observed) is int and observed >= 0, "SETTLED_USAGE_MISSING"); spent[axis] += observed
            else:
                require(observed is None or type(observed) is int and observed >= 0, "USAGE_INVALID")
                held[axis] += max(reservation["amount"][axis], observed or 0)
        check(not reservation.get("overrun"), "RESERVATION_OVERRUN", reservation["reservationId"])
    if control["mandate"]:
        mandate = control["mandate"]
        require(mandate["scope"] == "local-owner" and mandate["issuer"] == "local-owner" and mandate["limits"] == goal["budget"], "MANDATE_SCOPE")
    check(all(spent[a] + held[a] <= goal["budget"][a] for a in AXES), "BUDGET_EXCEEDED")
    facts = {f["factId"]: f for f in control["facts"]}
    for evaluation in evaluations:
        eid, permit = evaluation["evaluationId"], evaluation["permit"]
        require(evaluation["goalId"] == goal["goalId"] == permit["goalId"] and permit["mandateId"] == goal.get("mandateId"), "EVALUATION_SCOPE")
        check(all(ref in facts and facts[ref]["consumedBy"] == eid for ref in evaluation["triggerRefs"]), "TRIGGER_BINDING", eid)
        check(permit["reservationId"] in reservations, "EVALUATION_RESERVATION", eid)
    for fact in facts.values():
        if fact.get("kind") == "task.succeeded":
            event = next((e for e in control["events"] if e.get("eventId") == fact.get("eventId")), None)
            task = next((t for t in control["tasks"] if t["ref"]["taskId"] == fact.get("taskId")), None)
            check(bool(event and event.get("type") == "task.succeeded" and event.get("scope") == "local-owner"
                and event.get("payload", {}).get("taskId") == fact.get("taskId") and task
                and task["task"].get("terminal", {}).get("state") == "succeeded"
                and task["task"]["version"] == fact.get("taskVersion")), "TASK_TRIGGER_PROOF", fact["factId"])
    result = {"schemaVersion": 1, "phase": "3G", "mode": mode, "expectation": expectation, "capturedAt": stamp(),
              "planSha256": sha(canonical(plan).encode()), "executionPlanSha256": plan["executionPlanSha256"], "goalId": goal["goalId"],
              "requestId": safe_id(goal["requestId"]), "requiredSessions": required,
              "control": {key: [record(x) for x in value] if isinstance(value, list) else record(value) if isinstance(value, dict) else value
                          for key, value in control.items() if key != "tasks"},
              "tasks": [{"taskId": t["ref"]["taskId"], **{k: [record(v) for v in x] if isinstance(x, list) else record(x)
                         for k, x in t.items() if k != "ref"}} for t in control["tasks"]],
              "budget": {"limits": goal["budget"], "spent": spent, "held": held,
                         "available": {a: max(0, goal["budget"][a] - spent[a] - held[a]) for a in AXES},
                         "allReservationsSettled": all(r["state"] == "settled" for r in reservations.values()),
                         "wholeProviderBillingComplete": False},
              "native": [], "artifacts": [], "proofs": [], "issues": issues,
              "evaluationStatusCounts": dict(Counter(e["status"] for e in evaluations)),
              "hasUncertainty": any(e["status"] in ("claimed", "dispatching", "unknown") for e in evaluations)
                  or any(r["state"] == "unknown" for r in reservations.values()),
              "limitations": ["One read-only SQLite transaction; native files are separately stable-read, not a distributed atomic snapshot.",
                              "Only exact frozen Session identities are opened; no unrelated Session directory enumeration.",
                              "Message text/objectives/candidate reasons and file bodies are never emitted; only digests and selected metadata.",
                              "Native event counts and settled reservations are not complete transport/provider billing telemetry.",
                              "No live activation/disarm proof, restart/compaction acceptance or UI action proof is inferred from files.",
                              "Worker input has no separate exact-message receipt in this slice. Its Session binding and saved accounting event references are checked without inventing such a receipt.",
                              "Canonicalizer is a local Node built-in-only process matching JSON.stringify and localeCompare; no DSH imports."]}
    if mode == "inventory":
        result.update(status="inventory-only", completionVerified=False, nativeFilesRead=0)
        return result
    require(sorted(plan.get("sessions", []), key=canonical) == sorted(required, key=canonical), "SESSION_SCOPE_NOT_FROZEN")
    for session in required:
        paths = [Path(root) / session["sessionId"] / "session.v4.jsonl.zstd" for root in plan["paths"]["sessionRoots"]]
        found = [p for p in paths if p.exists()]
        require(len(found) == 1, "EXACT_SESSION_FILE")
        raw, fingerprint = stable_read(found[0], plan["limits"]["compressedSessionBytes"])
        result["native"].append({**session, **fingerprint, **native_events(raw, plan["limits"], binding.get("cwd") if session["role"] == "core" else None)})
    native = {s["sessionId"]: s for s in result["native"]}
    core = native.get(binding["sessionId"]) if binding else None
    for evaluation in evaluations:
        receipt, dispatch = evaluation.get("nativeReceipt"), evaluation.get("dispatch")
        if not receipt:
            matches = [e["seq"] for e in core["events"] if e["type"] == "user/message"
                       and e.get("messageId") == dispatch.get("messageId") and e.get("messageHash") == dispatch.get("messageHash")] if core and dispatch else []
            result["proofs"].append({"evaluationId": evaluation["evaluationId"], "nativeReceiptPresent": False,
                                     "dispatchInputObservedAtSeqs": matches, "exactNativeInputAndAssistant": False})
            check(evaluation["status"] not in ("committed", "rejected"), "NATIVE_RECEIPT_MISSING", evaluation["evaluationId"])
            continue
        valid = bool(core and dispatch and dispatch.get("goalId") == evaluation["goalId"] == evaluation["permit"]["goalId"]
                     and dispatch.get("goalRef") == evaluation["permit"]["goalRef"]
                     and receipt["sessionId"] == core["sessionId"] == dispatch["sessionId"]
                     and receipt["roundId"] == evaluation["evaluationId"] == dispatch["roundId"]
                     and receipt["messageId"] == dispatch["messageId"] and receipt["messageHash"] == dispatch["messageHash"])
        for field, kind in (("inputRef", "user/message"), ("assistantRef", "assistant/message")):
            ref = receipt[field]; seq = ref.get("eventSeq")
            event = core["events"][seq] if core and type(seq) is int and 0 <= seq < len(core["events"]) else None
            valid = valid and bool(event and ref["sessionId"] == receipt["sessionId"] and ref["durability"] == "confirmed"
                and event["type"] == kind and event.get("messageId") == ref["messageId"] and event.get("messageHash") == ref["messageHash"]
                and not event.get("interrupted"))
            if field == "inputRef":
                valid = valid and ref["messageId"] == receipt["messageId"] and ref["messageHash"] == receipt["messageHash"]
            else:
                valid = valid and bool(event and event.get("textSha256") == receipt["outputHash"])
        valid = valid and receipt["inputRef"]["eventSeq"] < receipt["assistantRef"]["eventSeq"]
        changes = [e["goal"] for e in core["events"][:receipt["inputRef"]["eventSeq"]] if "goal" in e] if core else []
        valid = valid and bool(changes and {k: changes[-1].get(k) for k in ("id", "revision")} == evaluation["permit"]["goalRef"] and changes[-1].get("phase") == "active")
        context_proof = native_input_window(core, receipt, binding.get("cwd") if binding else None)
        valid = valid and context_proof["nativeCwdContextVerified"]
        result["proofs"].append({"evaluationId": evaluation["evaluationId"], **context_proof,
                                 "exactNativeInputAndAssistant": check(valid, "NATIVE_MESSAGE_PROOF", evaluation["evaluationId"])})
    artifacts_complete = len(control["tasks"]) == len(plan["deliverables"])
    for task in control["tasks"]:
        tid, local, record_task = task["ref"]["taskId"], task["local"], task["task"]
        for saved in task["usage"]:
            observation = saved.get("observation", {})
            run = next((r for r in task["runs"] if r["reservationId"] == saved.get("reservation", {}).get("reservationId")), None)
            session = native.get(run.get("sessionId")) if run else None
            refs = observation.get("nativeObservations", [])
            matched = bool(run and session and run.get("taskId") == tid and refs)
            for ref in refs:
                seq = ref.get("seq")
                event = session["events"][seq] if session and type(seq) is int and 0 <= seq < len(session["events"]) else None
                matched = matched and bool(event and event["type"] == ref.get("type")
                    and all(event.get("usage", {}).get(k) == v for k, v in ref.get("usage", {}).items()))
            result["proofs"].append({"taskId": tid, "savedWorkerAccountingEventsMatch": matched,
                                     "workerInputExactReceiptAvailable": False})
            if observation.get("usage", {}).get("status") == "reported":
                check(matched, "WORKER_ACCOUNTING_EVENTS", tid)
        path = Path(plan["paths"]["workspaceRoot"]) / tid / "artifacts" / "note.txt"
        if not path.exists():
            result["artifacts"].append({"taskId": tid, "present": False}); artifacts_complete = False; continue
        raw, fingerprint = stable_read(path, 1024)
        file_ok = fingerprint["sha256"] == local["expectedSha256"] and len(raw) == local["byteLength"]
        result["artifacts"].append({"taskId": tid, "artifactRef": local["artifactRef"], "present": True, **fingerprint, "matches": file_ok})
        terminal = record_task.get("terminal", {}).get("state") == "succeeded"
        evidence = record_task.get("ready", {}).get("result", {})
        verified = record_task.get("verification", {})
        receipt_ok = False
        for effect in task["effects"]:
            if effect["effectId"] not in evidence.get("effectRefs", []): continue
            rec = next((r for r in task["receipts"] if r["receiptId"] == effect.get("receiptId")), None)
            obs = next((r for r in task["observations"] if r["receiptId"] == effect.get("receiptId")), None)
            run = next((r for r in task["runs"] if r["assignmentId"] == effect["origin"]["assignmentId"]), None)
            receipt_ok = bool(effect["status"] == "succeeded" and effect["authorization"]["mandateId"] == goal["mandateId"]
                and effect["origin"]["taskId"] == tid and rec and rec["outcome"] == "succeeded" and rec["effectId"] == effect["effectId"]
                and rec.get("claim") == effect.get("currentClaim") and rec.get("verification", {}).get("verified") is True
                and obs and obs.get("matched") is True and obs["observedSha256"] == local["expectedSha256"] and obs["observedBytes"] == local["byteLength"]
                and run and run["state"] == "reported" and run["reservationId"] == effect["effectId"])
        task_ok = bool(file_ok and terminal and receipt_ok and verified.get("resultHash") == local["expectedSha256"]
            and verified.get("checks") and all(c.get("status") == "pass" for c in verified["checks"]) and evidence.get("resultHash") == local["expectedSha256"])
        result["proofs"].append({"taskId": tid, "independentArtifactAndEffect": task_ok})
        artifacts_complete = artifacts_complete and task_ok
        if terminal: check(task_ok, "TASK_COMPLETION_PROOF", tid)
    changes = [e["goal"] for e in core["events"] if "goal" in e] if core else []
    latest = changes[-1] if changes else None
    if latest and binding:
        check({k: latest.get(k) for k in ("id", "revision")} == binding.get("goalRef"), "LATEST_NATIVE_GOAL_REF")
        check(latest.get("objectiveSha256") == plan["objectiveSha256"], "NATIVE_OBJECTIVE_HASH")
        check(all(g.get("roundsStarted") == 0 for g in changes), "UNEXPECTED_NATIVE_GOAL_ROUND")
    completion = binding.get("receipt", {}) if binding else {}
    candidate = any(e["status"] == "committed" and e.get("candidate", {}).get("kind") == "complete_candidate" for e in evaluations)
    complete = bool(not issues and artifacts_complete and candidate and latest and latest.get("phase") == "complete"
        and goal.get("native", {}).get("phase") == "complete" and completion.get("operation") == "complete" and completion.get("status") == "confirmed"
        and completion.get("completionProof", {}).get("completionCriteriaHash") == goal["completionCriteriaHash"]
        and all(e["status"] == "committed" for e in evaluations) and result["budget"]["allReservationsSettled"])
    if expectation == "complete": check(complete, "COMPLETION_NOT_VERIFIED")
    result.update(status="mismatch" if issues else "complete-verified" if complete else "consistent-incomplete", completionVerified=complete, nativeFilesRead=len(result["native"]))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("plan", "goal-id", "control-db", "workspace-root", "output"):
        parser.add_argument("--" + arg, required=True)
    parser.add_argument("--session-root", action="append", required=True)
    parser.add_argument("--mode", choices=("inventory", "audit"), default="audit")
    parser.add_argument("--expect", choices=("observe", "complete"), default="observe")
    args = parser.parse_args()
    try:
        raw, fingerprint = stable_read(args.plan)
        plan = json.loads(raw)
        require(args.goal_id == plan.get("goalId") and {"controlDb": args.control_db, "workspaceRoot": args.workspace_root,
                "sessionRoots": args.session_root} == plan.get("paths"), "CLI_PLAN_MISMATCH")
        result = collect(plan, args.mode, args.expect)
        result["planFile"] = fingerprint
        exclusive_json(args.output, result)
        print(json.dumps({"status": result["status"], "completionVerified": result["completionVerified"],
                          "nativeFilesRead": result["nativeFilesRead"], "issueCodes": [x["code"] for x in result["issues"]]}))
        return 1 if result["issues"] else 0
    except Exception as error:
        code = str(error) if isinstance(error, AuditError) else "AUDIT_INPUT_OR_STORAGE_ERROR"
        print(json.dumps({"status": "rejected", "code": code}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
