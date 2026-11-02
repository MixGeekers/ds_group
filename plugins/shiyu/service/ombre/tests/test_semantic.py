"""Offline v2 semantic protocol tests: real native files/SQLite and loopback HTTP.

No inference, DSH vault, upstream server, background worker or remote provider.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
import sys
from unittest.mock import patch

from test_controlled_store import PRODUCT, UPSTREAM, command_for
from test_harrier_profile import Fixture, unit_vector
from harrier_profile import PROFILE_FINGERPRINT, HARRIER_PROFILE
from protocol import ProtocolError, canonical, sha256
from service import create_store, create_mcp, read_embedding_key_file


class SemanticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="semantic-", dir=PRODUCT / ".local/ombre/tmp")
        self.root = Path(self.temp.name) / "vault"
        self.fixture = Fixture()
        self.store = self.open()
        await self.store.initialize()

    def open(self, semantic=True):
        return create_store(upstream=UPSTREAM, root=self.root, backend_id="ombre-local", scope="local-owner",
                            deployment_id="deployment-synthetic", embedding_endpoint=self.fixture.endpoint if semantic else None,
                            semantic_api=semantic, embedding_api_key="synthetic-key" if semantic else None)

    async def asyncTearDown(self):
        await self.store.close()
        self.fixture.close()
        self.temp.cleanup()

    async def save(self, name="memory-1", body="synthetic original body", meaning=""):
        if meaning:
            original = self.store.manager.create
            async def with_meaning(*args, **kwargs):
                return await original(*args, **kwargs, meaning=meaning)
            with patch.object(self.store.manager, "create", with_meaning):
                result = await self.store.create(*command_for(body, name))
        else:
            result = await self.store.create(*command_for(body, name))
        self.assertEqual(result["state"], "applied")
        return result

    def ref(self, body_result):
        receipt = body_result["receipt"]
        return {"memoryOperationId": body_result["operationId"], "bodyReceiptId": receipt["receiptId"],
                "nativeId": receipt["nativeId"], "componentVersion": receipt["componentVersion"], "bodyDigest": receipt["bodyDigest"]}

    async def index_command(self, saved, name="index-1", timeout_ms=20000):
        state = await self.store.semantic.backend_status("local-owner")
        command = {"schemaVersion": 1, "kind": "ensure-index", "indexOperationId": name,
                   **{key: state[key] for key in ("backendId", "deploymentId", "scope")}, **self.ref(saved),
                   "profileFingerprint": PROFILE_FINGERPRINT, "indexBaselineId": state["indexBaselineId"],
                   "expectedIndexWatermark": state["indexWatermark"], "deadlineAtMs": int(time.time() * 1000) + timeout_ms,
                   "maxEmbeddingCalls": 2}
        return command, sha256(canonical(command).encode())

    async def search_request(self, saved=(), **changes):
        state = await self.store.semantic.backend_status("local-owner")
        return {"scope": "local-owner", "query": "synthetic query", "limit": 5,
                "eligibleRefs": sorted([self.ref(item) for item in saved], key=lambda ref: ref["nativeId"]),
                "profileFingerprint": PROFILE_FINGERPRINT, "expectedIndexBaselineId": state["indexBaselineId"],
                "expectedIndexWatermark": state["indexWatermark"], "deadlineAtMs": int(time.time() * 1000) + 20000, **changes}

    async def test_exact_seven_tools_and_v1_creation_enqueues_without_model(self):
        names = {tool.name for tool in await create_mcp(self.store).list_tools()}
        self.assertEqual(names, {"shiyu_memory_create", "shiyu_memory_get", "shiyu_memory_operation_status", "shiyu_memory_backend_status",
                                "shiyu_memory_index_ensure", "shiyu_memory_index_status", "shiyu_memory_search_candidates"})
        saved = await self.save()
        self.assertEqual(self.fixture.calls, [])
        self.assertEqual(saved["receipt"]["indexState"], "unknown")
        self.assertEqual(self.store.manager.embedding_outbox.status()["pending"], 1)
        self.assertFalse(self.store.manager.embedding_outbox.running)

    async def test_explicit_index_preserves_body_receipt_and_readonly_status(self):
        saved = await self.save()
        request = await self.search_request([saved])
        missing = await self.store.semantic.search_candidates(**request)
        self.assertEqual(missing["state"], "index_required")
        self.assertEqual(missing["embeddingCalls"], 0)
        args = await self.index_command(saved)
        indexed = await self.store.semantic.index_ensure(*args)
        self.assertEqual(indexed["state"], "applied")
        receipt = indexed["receipt"]
        self.assertEqual(receipt["indexWatermark"], 1)
        self.assertEqual(receipt["embeddingCalls"], 1)
        self.assertEqual(receipt["content"]["digest"], saved["receipt"]["bodyDigest"])
        self.assertEqual(receipt["meaning"], {"state": "absent", "digest": None, "vectorHash": None, "dimensions": None})
        self.assertEqual(len(receipt["content"]["vectorHash"]), 64)
        native_before = (await self.store.get(saved["nativeId"], "local-owner"))["componentVersion"]
        old_changes = self.store.semantic.db.total_changes
        for _ in range(2):
            self.assertEqual(await self.store.semantic.index_status("index-1", "local-owner"), indexed)
            await self.store.semantic.backend_status("local-owner")
            self.assertEqual((await self.store.operation_status(saved["operationId"], "local-owner"))["receipt"], saved["receipt"])
        self.assertEqual(self.store.semantic.db.total_changes, old_changes)
        self.assertEqual(len(self.fixture.calls), 1)
        self.assertEqual((await self.store.get(saved["nativeId"], "local-owner"))["componentVersion"], native_before)
        self.assertEqual(await self.store.semantic.index_ensure(*args), indexed)
        self.assertEqual(len(self.fixture.calls), 1)

    async def test_content_and_meaning_two_actual_calls_and_separate_proof(self):
        saved = await self.save(meaning="synthetic meaning 中文")
        self.assertEqual(self.fixture.calls, [])
        result = await self.store.semantic.index_ensure(*await self.index_command(saved))
        self.assertEqual(result["state"], "applied")
        self.assertEqual(result["embeddingCalls"], 2)
        self.assertEqual(result["receipt"]["meaning"]["state"], "indexed")
        self.assertEqual(result["receipt"]["meaning"]["digest"], sha256("synthetic meaning 中文".encode()))
        self.assertEqual([call["body"]["input"][0] for call in self.fixture.calls], ["synthetic original body", "synthetic meaning 中文"])
        self.assertTrue(all(call["authorization"] == "Bearer synthetic-key" for call in self.fixture.calls))

    async def test_unknown_provider_failure_never_replays_or_repairs_on_status_reopen(self):
        saved = await self.save()
        args = await self.index_command(saved)
        self.fixture.status = 500
        unknown = await self.store.semantic.index_ensure(*args)
        self.assertEqual(unknown["state"], "unknown")
        self.assertEqual(unknown["embeddingCalls"], 1)
        self.fixture.status = 200
        self.assertEqual((await self.store.semantic.index_ensure(*args))["state"], "unknown")
        self.assertEqual(len(self.fixture.calls), 1)
        await self.store.close()
        self.store = self.open()
        await self.store.initialize()
        self.assertEqual((await self.store.semantic.index_status("index-1", "local-owner"))["state"], "unknown")
        self.assertEqual(len(self.fixture.calls), 1)
        self.assertEqual((await self.store.semantic.backend_status("local-owner"))["indexWatermark"], 0)

    async def test_cancel_after_content_write_remains_unknown_without_recovery(self):
        saved = await self.save(meaning="other meaning")
        original = self.store.manager.embedding_engine.generate_and_store_meaning
        async def cancel(*args):
            raise asyncio.CancelledError()
        with patch.object(self.store.manager.embedding_engine, "generate_and_store_meaning", cancel):
            with self.assertRaises(asyncio.CancelledError):
                await self.store.semantic.index_ensure(*await self.index_command(saved))
        self.assertEqual((await self.store.semantic.index_status("index-1", "local-owner"))["state"], "unknown")
        self.assertEqual(len(self.fixture.calls), 1)
        self.assertEqual((await self.store.semantic.search_candidates(**await self.search_request([saved])))["state"], "index_required")

    async def test_search_native_rank_allowed_ids_and_empty_set_no_model(self):
        first = await self.save("memory-1", "first synthetic")
        second = await self.save("memory-2", "second synthetic")
        self.fixture.response = {"data": [{"index": 0, "embedding": unit_vector(1)}]}
        await self.store.semantic.index_ensure(*await self.index_command(first, "index-1"))
        self.fixture.response = {"data": [{"index": 0, "embedding": unit_vector(0)}]}
        await self.store.semantic.index_ensure(*await self.index_command(second, "index-2"))
        self.store.manager.search = lambda *_args, **_kwargs: self.fail("hybrid/BM25 path must not run")
        before = len(self.fixture.calls)
        empty = await self.store.semantic.search_candidates(**await self.search_request())
        self.assertEqual(empty["matches"], [])
        self.assertEqual(len(self.fixture.calls), before)
        only_first = await self.store.semantic.search_candidates(**await self.search_request([first]))
        self.assertEqual([item["nativeId"] for item in only_first["matches"]], [first["nativeId"]])
        self.assertEqual(only_first["matches"][0]["score"], 0)
        both = await self.store.semantic.search_candidates(**await self.search_request([first, second]))
        self.assertEqual([item["nativeId"] for item in both["matches"]], [second["nativeId"], first["nativeId"]])
        self.assertEqual(both["embeddingCalls"], 0)  # Same role/input query cache.
        self.assertEqual(self.fixture.calls[-1]["body"]["input"], [HARRIER_PROFILE["query_prefix"] + "synthetic query"])
        self.assertNotIn("body", both["matches"][0])

    async def test_one_missing_candidate_blocks_search_without_partial_claim(self):
        first, second = await self.save(), await self.save("memory-2", "unindexed synthetic")
        await self.store.semantic.index_ensure(*await self.index_command(first))
        before = len(self.fixture.calls)
        result = await self.store.semantic.search_candidates(**await self.search_request([first, second]))
        self.assertEqual(result["state"], "index_required")
        self.assertEqual(result["coverage"], {"eligibleCount": 2, "indexedCount": 1, "missingCount": 1})
        self.assertEqual(result["matches"], [])
        self.assertEqual(len(self.fixture.calls), before)

    async def test_deadline_includes_queue_and_prevents_late_provider_dispatch(self):
        saved = await self.save()
        await self.store._mutex.acquire()
        try:
            request = {"scope": "local-owner", "query": "late", "limit": 1, "eligibleRefs": [], "profileFingerprint": PROFILE_FINGERPRINT,
                       "expectedIndexBaselineId": "index_" + "0" * 32, "expectedIndexWatermark": 0,
                       "deadlineAtMs": int(time.time() * 1000) + 10}
            task = asyncio.create_task(self.store.semantic.search_candidates(**request))
            await asyncio.sleep(0.03)
        finally:
            self.store._mutex.release()
        with self.assertRaisesRegex(ProtocolError, "DEADLINE_EXCEEDED"):
            await task
        self.assertEqual(self.fixture.calls, [])

    async def test_binding_profile_deadline_and_index_operation_conflict_fail_closed(self):
        saved = await self.save()
        command, digest = await self.index_command(saved)
        for changes in ({"profileFingerprint": "0" * 64}, {"maxEmbeddingCalls": 3}, {"deploymentId": "other"},
                        {"bodyReceiptId": "receipt_" + "0" * 64}, {"expectedIndexWatermark": 1}, {"deadlineAtMs": 1}):
            changed = {**command, **changes}
            with self.subTest(changes=changes), self.assertRaises(ProtocolError):
                await self.store.semantic.index_ensure(changed, sha256(canonical(changed).encode()))
        self.assertEqual(self.fixture.calls, [])
        await self.store.semantic.index_ensure(command, digest)
        changed = {**command, "deadlineAtMs": command["deadlineAtMs"] + 1}
        with self.assertRaisesRegex(ProtocolError, "INDEX_OPERATION_CONFLICT"):
            await self.store.semantic.index_ensure(changed, sha256(canonical(changed).encode()))

    async def test_proof_tamper_never_repairs_and_cannot_rank(self):
        saved = await self.save()
        await self.store.semantic.index_ensure(*await self.index_command(saved))
        with sqlite3.connect(self.store.manager.embedding_engine.db_path) as db:
            db.execute("UPDATE embeddings SET meaning_embedding=embedding")
        before = len(self.fixture.calls)
        self.assertEqual((await self.store.semantic.index_status("index-1", "local-owner"))["state"], "unknown")
        result = await self.store.semantic.search_candidates(**await self.search_request([saved]))
        self.assertEqual(result["state"], "index_required")
        self.assertEqual(len(self.fixture.calls), before)

    async def test_reopen_preserves_baseline_watermark_receipt_and_missing_meta_refused(self):
        saved = await self.save()
        indexed = await self.store.semantic.index_ensure(*await self.index_command(saved))
        await self.store.close()
        self.store = self.open()
        await self.store.initialize()
        self.assertEqual((await self.store.semantic.index_status("index-1", "local-owner"))["receipt"], indexed["receipt"])
        self.store.semantic.db.execute("DELETE FROM meta")
        with self.assertRaisesRegex(ProtocolError, "INDEX_BASELINE_MISSING"):
            await self.store.semantic.backend_status("local-owner")
        self.assertEqual(len(self.fixture.calls), 1)

    async def test_v1_disabled_saved_body_can_only_index_by_explicit_v2_command(self):
        await self.store.close()
        # A separate synthetic prior v1 installation, with no semantic baseline.
        self.root = Path(self.temp.name) / "prior-v1"
        self.store = self.open(semantic=False)
        saved = await self.save()
        self.assertEqual(saved["receipt"]["indexState"], "disabled")
        await self.store.close()
        self.store = self.open()
        await self.store.initialize()
        self.assertEqual(self.fixture.calls, [])
        self.assertEqual((await self.store.operation_status(saved["operationId"], "local-owner"))["receipt"], saved["receipt"])
        await self.store.semantic.index_ensure(*await self.index_command(saved))
        self.assertEqual(len(self.fixture.calls), 1)
        self.assertEqual((await self.store.operation_status(saved["operationId"], "local-owner"))["receipt"], saved["receipt"])

    async def test_key_file_and_semantic_mode_validation(self):
        path = Path(self.temp.name) / "owned.key"
        path.write_text("synthetic-key\n")
        path.chmod(0o600)
        self.assertEqual(read_embedding_key_file(path), "synthetic-key")
        path.chmod(0o644)
        with self.assertRaisesRegex(ProtocolError, "INVALID_KEY_FILE"):
            read_embedding_key_file(path)
        path.chmod(0o600)
        link = Path(self.temp.name) / "key-link"
        link.symlink_to(path)
        with self.assertRaisesRegex(ProtocolError, "INVALID_KEY_FILE"):
            read_embedding_key_file(link)
        fifo = Path(self.temp.name) / "fifo.key"
        os.mkfifo(fifo, 0o600)
        with self.assertRaisesRegex(ProtocolError, "INVALID_KEY_FILE"):
            read_embedding_key_file(fifo)
        with self.assertRaisesRegex(ProtocolError, "EMBEDDING_REQUIRED"):
            create_store(upstream=UPSTREAM, root=Path(self.temp.name) / "no-model", backend_id="ombre-local", scope="local-owner",
                         deployment_id="deployment-synthetic", semantic_api=True)

    async def test_scan_cap_rejects_new_row_before_intent_and_model(self):
        saved = await self.save()
        from ombrebrain.storage.vector_codec import encode_vector
        with sqlite3.connect(self.store.manager.embedding_engine.db_path) as db:
            db.executemany("INSERT INTO embeddings(bucket_id,embedding,updated_at,content_hash) VALUES(?,?,?,?)",
                           [(f"synthetic-{i}", encode_vector(unit_vector()), "synthetic", "0" * 64) for i in range(2048)])
        with self.assertRaisesRegex(ProtocolError, "INDEX_SCAN_LIMIT"):
            await self.store.semantic.index_ensure(*await self.index_command(saved))
        self.assertEqual((await self.store.semantic.index_status("index-1", "local-owner"))["state"], "absent")
        self.assertEqual(self.fixture.calls, [])

    async def test_sync_proof_turn_cannot_publish_after_deadline(self):
        saved = await self.save()
        args = await self.index_command(saved, timeout_ms=30)
        import semantic
        original = semantic._sync_directory
        def slow_sync(path):
            time.sleep(0.04)
            return original(path)
        with patch.object(semantic, "_sync_directory", slow_sync):
            with self.assertRaisesRegex(ProtocolError, "DEADLINE_EXCEEDED"):
                await self.store.semantic.index_ensure(*args)
        status = await self.store.semantic.index_status("index-1", "local-owner")
        self.assertEqual(status["state"], "unknown")
        self.assertEqual(status["currentIndexWatermark"], 0)

    async def test_cached_sync_ranking_cannot_release_after_deadline(self):
        saved = await self.save()
        await self.store.semantic.index_ensure(*await self.index_command(saved))
        original = self.store.manager.embedding_engine.search_similar_strict
        async def slow_rank(*args, **kwargs):
            result = await original(*args, **kwargs)
            time.sleep(0.04)
            return result
        request = await self.search_request([saved], deadlineAtMs=int(time.time() * 1000) + 30)
        with patch.object(self.store.manager.embedding_engine, "search_similar_strict", slow_rank):
            with self.assertRaisesRegex(ProtocolError, "DEADLINE_EXCEEDED"):
                await self.store.semantic.search_candidates(**request)

    async def test_provider_failure_is_not_empty_success_or_bm25_fallback(self):
        saved = await self.save()
        await self.store.semantic.index_ensure(*await self.index_command(saved))
        self.fixture.status = 500
        with self.assertRaisesRegex(ProtocolError, "SEMANTIC_QUERY_FAILED"):
            await self.store.semantic.search_candidates(**await self.search_request([saved]))
        self.assertEqual(len(self.fixture.calls), 2)

    async def test_real_stdio_v2_key_and_wire_roundtrip(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        key_file = Path(self.temp.name) / "stdio.key"
        key_file.write_text("synthetic-key\n")
        key_file.chmod(0o600)
        child_root = Path(self.temp.name) / "stdio-vault"
        entrypoint = Path(__file__).resolve().parents[1] / "service.py"
        params = StdioServerParameters(command=sys.executable, args=["-I", "-B", "-u", str(entrypoint),
            "--upstream", str(UPSTREAM), "--root", str(child_root), "--backend-id", "ombre-local", "--scope", "local-owner",
            "--deployment-id", "deployment-synthetic", "--embedding-endpoint", self.fixture.endpoint,
            "--semantic-api", "--embedding-key-file", str(key_file)], env={})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                self.assertEqual(len((await session.list_tools()).tools), 7)
                state = (await session.call_tool("shiyu_memory_backend_status", {"scope": "local-owner"})).structuredContent
                cmd, digest, body = command_for()
                saved = (await session.call_tool("shiyu_memory_create", {"command": cmd, "commandDigest": digest, "body": body})).structuredContent
                self.assertEqual(saved["state"], "applied")
                self.assertEqual(self.fixture.calls, [])
                index = {"schemaVersion": 1, "kind": "ensure-index", "indexOperationId": "stdio-index",
                         **self.ref(saved), **{key: state[key] for key in ("backendId", "deploymentId", "scope", "profileFingerprint", "indexBaselineId")},
                         "expectedIndexWatermark": 0, "deadlineAtMs": int(time.time() * 1000) + 20000, "maxEmbeddingCalls": 2}
                result = await session.call_tool("shiyu_memory_index_ensure", {"command": index, "commandDigest": sha256(canonical(index).encode())})
                self.assertFalse(result.isError)
                indexed = result.structuredContent
                self.assertEqual(indexed["state"], "applied")
                status = (await session.call_tool("shiyu_memory_index_status", {"indexOperationId": "stdio-index", "scope": "local-owner"})).structuredContent
                self.assertEqual(status, indexed)
                request = {"scope": "local-owner", "query": "synthetic query", "limit": 1, "eligibleRefs": [self.ref(saved)],
                           "profileFingerprint": PROFILE_FINGERPRINT, "expectedIndexBaselineId": state["indexBaselineId"],
                           "expectedIndexWatermark": 1, "deadlineAtMs": int(time.time() * 1000) + 20000}
                found = (await session.call_tool("shiyu_memory_search_candidates", request)).structuredContent
                self.assertEqual(found["state"], "ok")
                self.assertEqual(found["matches"][0]["nativeId"], saved["nativeId"])
                self.assertNotIn("synthetic-key", json.dumps(found))
        self.assertEqual(len(self.fixture.calls), 2)


if __name__ == "__main__":
    unittest.main()
