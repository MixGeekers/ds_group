from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
from protocol import ProtocolError, canonical, sha256
from service import create_store, create_mcp

PRODUCT = HERE.parents[1]
UPSTREAM = PRODUCT / ".local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935"


def command_for(body="synthetic ordinary memory 一", operation_id="op-1"):
    command = {"schemaVersion": 1, "kind": "create", "operationId": operation_id, "backendId": "ombre-local",
               "scope": "local-owner", "targetRef": "target-1", "bodyDigest": sha256(body.encode()),
               "bodyBytes": len(body.encode()), "sourceRefs": [{"sourceId": "source-1", "revision": 1}]}
    return command, sha256(canonical(command).encode()), body


class ControlledStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ordinary-service-", dir=PRODUCT / ".local/ombre/tmp")
        self.root = Path(self.temp.name) / "vault"
        self.store = self.open()
        await self.store.initialize()

    def open(self, **options):
        return create_store(upstream=UPSTREAM, root=self.root, backend_id="ombre-local", scope="local-owner",
                            deployment_id=options.get("deployment_id", "deployment-synthetic"))

    async def asyncTearDown(self):
        await self.store.close()
        self.temp.cleanup()

    async def reopen(self):
        await self.store.close()
        self.store = self.open()
        await self.store.initialize()

    async def test_create_exact_get_and_reopen(self):
        result = await self.store.create(*command_for())
        self.assertEqual(result["state"], "applied")
        self.assertTrue(result["receipt"]["bodyDurable"])
        self.assertRegex(result["receipt"]["observedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        read = await self.store.get(result["nativeId"], "local-owner")
        self.assertEqual(read["state"], "found")
        self.assertEqual(read["body"], command_for()[2])
        native = await self.store.manager.get_including_archive(result["nativeId"])
        self.assertEqual(native["metadata"]["type"], "dynamic")
        self.assertNotIn("provenance", native["metadata"])
        await self.reopen()
        self.assertEqual(await self.store.get(result["nativeId"], "local-owner"), read)
        self.assertEqual((await self.store.operation_status("op-1", "local-owner"))["receipt"], result["receipt"])

    async def test_same_operation_never_recreates(self):
        first = await self.store.create(*command_for())
        self.store.manager.create = lambda *_args, **_kwargs: self.fail("native create was replayed")
        self.assertEqual(await self.store.create(*command_for()), first)
        self.assertEqual(len(list(self.root.rglob("*.md"))), 1)

    async def test_operation_id_cannot_change_command(self):
        await self.store.create(*command_for())
        with self.assertRaisesRegex(ProtocolError, "OPERATION_ID_CONFLICT"):
            await self.store.create(*command_for("changed body"))

    async def test_invalid_body_never_registers_intent(self):
        for body in (" leading", "trailing\n", "bad\x00body", "\u202ebidi", "a\rb", "a\r\nb", "", "x" * 16385):
            with self.assertRaises(ProtocolError):
                await self.store.create(*command_for(body))
        self.assertEqual((await self.store.operation_status("op-1", "local-owner"))["state"], "absent")
        self.assertEqual(list(self.root.rglob("*.md")), [])

    async def test_wrong_scope_and_bad_hash_rejected(self):
        cmd, digest, body = command_for()
        cmd["bodyDigest"] = "0" * 64
        with self.assertRaisesRegex(ProtocolError, "BODY_DIGEST_MISMATCH"):
            await self.store.create(cmd, digest, body)
        with self.assertRaisesRegex(ProtocolError, "BINDING_MISMATCH"):
            await self.store.get("missing", "other")
        with self.assertRaisesRegex(ProtocolError, "BINDING_MISMATCH"):
            await self.store.operation_status("op-1", "other")

    async def test_cross_language_unicode_command_digest(self):
        command, digest, body = command_for("合成记忆 🪶")
        self.assertEqual(command["bodyBytes"], 17)
        self.assertEqual(digest, "e69a2de3b025b7256112be410c09b0868328b035aef723e072f2a78903583ede")
        self.assertEqual((await self.store.create(command, digest, body))["state"], "applied")

    async def test_source_refs_safe_integer_and_sorted_unique(self):
        for refs in ([{"sourceId": "source-1", "revision": True}], [{"sourceId": "source-1", "revision": 9007199254740992}],
                     [{"sourceId": "z", "revision": 1}, {"sourceId": "a", "revision": 1}], []):
            cmd, _, body = command_for()
            cmd["sourceRefs"] = refs
            with self.assertRaises(ProtocolError):
                await self.store.create(cmd, sha256(canonical(cmd).encode()), body)

    async def test_second_process_lease_and_wrong_deployment_fail_closed(self):
        with self.assertRaisesRegex(ProtocolError, "VAULT_ALREADY_OPEN"):
            self.open()
        await self.store.close()
        with self.assertRaisesRegex(ProtocolError, "JOURNAL_BINDING_MISMATCH"):
            self.open(deployment_id="wrong-deployment")
        self.store = self.open()

    async def test_missing_journal_metadata_is_not_new_installation(self):
        await self.store.close()
        db = sqlite3.connect(self.root / ".shiyu/operations.sqlite3")
        db.execute("DELETE FROM installation")
        db.commit()
        db.close()
        with self.assertRaisesRegex(ProtocolError, "JOURNAL_BINDING_MISMATCH"):
            self.open()

    async def test_existing_native_data_without_journal_rejected(self):
        await self.store.close()
        self.root = Path(self.temp.name) / "unbound"
        self.root.mkdir()
        (self.root / "existing.md").write_text("synthetic")
        with self.assertRaisesRegex(ProtocolError, "UNBOUND_EXISTING_VAULT"):
            self.open()

    async def test_after_intent_failure_stays_unknown_on_reopen(self):
        async def failure(*_args, **_kwargs):
            raise RuntimeError("injected before native dispatch")
        self.store.manager.create = failure
        result = await self.store.create(*command_for())
        self.assertEqual(result["state"], "unknown")
        await self.reopen()
        self.assertEqual((await self.store.create(*command_for()))["state"], "unknown")
        self.assertEqual(list(self.root.rglob("*.md")), [])

    async def test_after_native_publication_failure_recovers_without_rewrite(self):
        native_create = self.store.manager.create
        async def publish_then_fail(*args, **kwargs):
            await native_create(*args, **kwargs)
            raise RuntimeError("injected lost native return")
        self.store.manager.create = publish_then_fail
        result = await self.store.create(*command_for())
        self.assertEqual(result["state"], "unknown")
        native_files = list(self.root.rglob("*.md"))
        before = native_files[0].read_bytes()
        await self.reopen()
        recovered = await self.store.operation_status("op-1", "local-owner")
        self.assertEqual(recovered["state"], "applied")
        self.assertTrue(recovered["receipt"]["reconciled"])
        self.assertEqual(native_files[0].read_bytes(), before)
        self.assertEqual(len(list(self.root.rglob("*.md"))), 1)

    async def test_cancel_after_publication_recovers_only_on_explicit_initialize(self):
        native_create = self.store.manager.create
        published = asyncio.Event()
        async def publish_then_block(*args, **kwargs):
            await native_create(*args, **kwargs)
            published.set()
            await asyncio.Future()
        self.store.manager.create = publish_then_block
        task = asyncio.create_task(self.store.create(*command_for()))
        await asyncio.wait_for(published.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual((await self.store.operation_status("op-1", "local-owner"))["state"], "unknown")
        await self.reopen()
        self.assertEqual((await self.store.operation_status("op-1", "local-owner"))["state"], "applied")

    async def test_native_file_tamper_get_and_status_fail_closed(self):
        result = await self.store.create(*command_for())
        file = next(self.root.rglob("*.md"))
        file.write_text(file.read_text().replace("synthetic ordinary", "tampered ordinary"))
        read = await self.store.get(result["nativeId"], "local-owner")
        self.assertEqual(read["state"], "mismatch")
        self.assertIsNone(read["body"])
        self.assertEqual((await self.store.operation_status("op-1", "local-owner"))["state"], "unknown")

    async def test_missing_id_does_not_search_or_return_other_memory(self):
        await self.store.create(*command_for())
        self.store.manager.get_including_archive = lambda *_args: self.fail("unknown journal ID should not read native vault")
        self.assertEqual((await self.store.get("not-present", "local-owner"))["state"], "not_found")

    async def test_racing_collision_cannot_suffix_into_second_memory(self):
        known = uuid.UUID("12345678-1234-1234-1234-123456789abc")
        planned = "shiyu_" + known.hex
        await self.store.manager.create("existing synthetic", bucket_id_override=planned)
        original_find = self.store.manager._find_bucket_file
        calls = 0
        def collision_after_preflight(native_id):
            nonlocal calls
            calls += 1
            return None if calls == 1 else original_find(native_id)
        self.store.manager._find_bucket_file = collision_after_preflight
        with patch("controlled_store.uuid.uuid4", return_value=known):
            result = await self.store.create(*command_for())
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["reason"], "NATIVE_ID_COLLISION")
        self.assertEqual(len(list(self.root.rglob("*.md"))), 1)

    async def test_only_three_tools_no_upstream_server_import(self):
        names = {tool.name for tool in await create_mcp(self.store).list_tools()}
        self.assertEqual(names, {"shiyu_memory_create", "shiyu_memory_get", "shiyu_memory_operation_status"})
        self.assertNotIn("server", sys.modules)

    async def test_mcp_does_not_read_dotenv_settings(self):
        from pydantic_settings.sources import DotEnvSettingsSource
        def guarded_read(source):
            self.assertIsNone(source.env_file, "dotenv path must be disabled before source construction")
            return {}
        with patch.object(DotEnvSettingsSource, "_read_env_files", guarded_read):
            names = {tool.name for tool in await create_mcp(self.store).list_tools()}
        self.assertEqual(len(names), 3)

    async def test_journal_contains_no_body(self):
        await self.store.create(*command_for())
        rows = self.store._db.execute("SELECT * FROM operations").fetchall()
        text = json.dumps([dict(row) for row in rows], ensure_ascii=False)
        self.assertNotIn(command_for()[2], text)
        self.assertEqual(rows[0]["state"], "applied")


class StdioIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_owned_process_kill_before_and_after_native_publication(self):
        # Actual owned child termination, not an assertion that SIGKILL models power loss.
        script = """
import asyncio,os,signal,sys
sys.path.insert(0,sys.argv[1]); sys.dont_write_bytecode=True
from service import create_store
from protocol import canonical,sha256
async def run():
    store=create_store(upstream=sys.argv[2],root=sys.argv[3],backend_id='ombre-local',scope='local-owner',deployment_id='killed-synthetic')
    await store.initialize()
    native=store.manager.create
    async def killed(*args,**kwargs):
        if sys.argv[4]=='published': await native(*args,**kwargs)
        os.kill(os.getpid(),signal.SIGKILL)
    store.manager.create=killed
    body='ordinary killed-process synthetic'
    cmd={'schemaVersion':1,'kind':'create','operationId':'killed-op','backendId':'ombre-local','scope':'local-owner','targetRef':'target-1','bodyDigest':sha256(body.encode()),'bodyBytes':len(body.encode()),'sourceRefs':[{'sourceId':'source-1','revision':1}]}
    await store.create(cmd,sha256(canonical(cmd).encode()),body)
asyncio.run(run())
"""
        with tempfile.TemporaryDirectory(prefix="kill-ordinary-", dir=PRODUCT / ".local/ombre/tmp") as temp:
            for stage in ("intent", "published"):
                root = Path(temp) / stage
                process = await asyncio.create_subprocess_exec(sys.executable, "-c", script, str(HERE), str(UPSTREAM), str(root), stage,
                    env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                self.assertEqual(await asyncio.wait_for(process.wait(), 10), -9)
                files_before = {str(p.relative_to(root)): sha256(p.read_bytes()) for p in root.rglob("*.md")}
                store = create_store(upstream=UPSTREAM, root=root, backend_id="ombre-local", scope="local-owner", deployment_id="killed-synthetic")
                try:
                    await store.initialize()
                    status = await store.operation_status("killed-op", "local-owner")
                    self.assertEqual(status["state"], "applied" if stage == "published" else "unknown")
                    self.assertEqual({str(p.relative_to(root)): sha256(p.read_bytes()) for p in root.rglob("*.md")}, files_before)
                    if stage == "published":
                        self.assertTrue(status["receipt"]["reconciled"])
                finally:
                    await store.close()

    async def test_real_stdio_normal_restart_exact_read(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        with tempfile.TemporaryDirectory(prefix="stdio-ordinary-", dir=PRODUCT / ".local/ombre/tmp") as root:
            params = StdioServerParameters(command=sys.executable, args=["-I", str(HERE / "service.py"), "--upstream", str(UPSTREAM),
                "--root", root, "--backend-id", "ombre-local", "--scope", "local-owner", "--deployment-id", "stdio-synthetic",
                "--without-embedding"], env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self.assertEqual(len((await session.list_tools()).tools), 3)
                    command, digest, body = command_for()
                    result = await session.call_tool("shiyu_memory_create", {"command": command, "commandDigest": digest, "body": body})
                    self.assertFalse(result.isError)
                    value = result.structuredContent
                    self.assertEqual(value, json.loads(result.content[0].text))
                    self.assertEqual(value["state"], "applied")
                    native_id = value["nativeId"]
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("shiyu_memory_get", {"nativeId": native_id, "scope": "local-owner"})
                    self.assertEqual(result.structuredContent["body"], body)
                    self.assertEqual(result.structuredContent["receipt"], value["receipt"])


if __name__ == "__main__":
    unittest.main()
