"""Small, body-free command contract shared with the trusted TS control domain."""
from __future__ import annotations

import hashlib
import json
import re

MAX_BODY_BYTES = 16384
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}\Z", re.ASCII)
HEX = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
FIELDS = {"schemaVersion", "kind", "operationId", "backendId", "scope", "targetRef", "bodyDigest", "bodyBytes", "sourceRefs"}


class ProtocolError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def identifier(value, *, operation=False):
    if not isinstance(value, str) or not ID.fullmatch(value) or (operation and len(value) > 150):
        raise ProtocolError("INVALID_IDENTIFIER")
    return value


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate(command, command_digest, body, *, backend_id, scope):
    if not isinstance(command, dict) or set(command) != FIELDS:
        raise ProtocolError("INVALID_COMMAND")
    if type(command["schemaVersion"]) is not int or command["schemaVersion"] != 1 or command["kind"] != "create":
        raise ProtocolError("INVALID_COMMAND")
    for field in ("operationId", "backendId", "scope", "targetRef"):
        identifier(command[field], operation=field == "operationId")
    if command["backendId"] != backend_id or command["scope"] != scope:
        raise ProtocolError("BINDING_MISMATCH")
    refs = command["sourceRefs"]
    if not isinstance(refs, list) or not 1 <= len(refs) <= 32:
        raise ProtocolError("INVALID_SOURCE_REFS")
    prior = ""
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != {"sourceId", "revision"}:
            raise ProtocolError("INVALID_SOURCE_REFS")
        source_id = identifier(ref["sourceId"])
        if source_id <= prior or type(ref["revision"]) is not int or not 1 <= ref["revision"] <= 9007199254740991:
            raise ProtocolError("INVALID_SOURCE_REFS")
        prior = source_id
    if not isinstance(body, str):
        raise ProtocolError("INVALID_BODY")
    try:
        raw = body.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise ProtocolError("INVALID_UNICODE") from exc
    if not 1 <= len(raw) <= MAX_BODY_BYTES or type(command["bodyBytes"]) is not int or command["bodyBytes"] != len(raw):
        raise ProtocolError("BODY_SIZE_MISMATCH")
    digest = command["bodyDigest"]
    if not isinstance(digest, str) or not HEX.fullmatch(digest) or digest != sha256(raw):
        raise ProtocolError("BODY_DIGEST_MISMATCH")
    if not isinstance(command_digest, str) or not HEX.fullmatch(command_digest) or command_digest != sha256(canonical(command).encode("utf-8")):
        raise ProtocolError("COMMAND_DIGEST_MISMATCH")
    return json.loads(canonical(command))
