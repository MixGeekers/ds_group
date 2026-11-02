"""Private stdio-only MCP entrypoint. No upstream server or public tools import."""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from controlled_store import ControlledStore, strict_manager_class
from protocol import ProtocolError


def verified_upstream(path):
    root = Path(path).resolve(strict=True)
    source = json.loads(Path(__file__).with_name("SOURCE.json").read_text())
    rows = [(str(f.relative_to(root)), hashlib.sha256(f.read_bytes()).hexdigest()) for f in sorted((root / "src").rglob("*.py"))]
    digest = hashlib.sha256(json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if len(rows) != source["pythonSourceFiles"] or digest != source["pythonTreeSha256"]:
        raise ProtocolError("UPSTREAM_SOURCE_MISMATCH")
    if (root / "VERSION").read_text().strip() != source["version"]:
        raise ProtocolError("UPSTREAM_VERSION_MISMATCH")
    for filename, key in (("requirements.lock.txt", "requirementsLockSha256"), ("LICENSE", "licenseSha256")):
        if hashlib.sha256((root / filename).read_bytes()).hexdigest() != source[key]:
            raise ProtocolError("UPSTREAM_SOURCE_MISMATCH")
    return root


def create_store(*, upstream, root, backend_id, scope, deployment_id, embedding_endpoint=None):
    source = verified_upstream(upstream)
    sys.path.insert(0, str(source / "src"))
    from bucket_manager import BucketManager
    manager_class = strict_manager_class(BucketManager)

    def factory(buckets):
        config = {"buckets_dir": str(buckets), "limits": {"max_bucket_bytes": 16384},
                  "embedding": {"enabled": bool(embedding_endpoint), "background_indexing": False},
                  "storage": {"external_change_poll_seconds": 0}}
        engine = None
        if embedding_endpoint:
            import embedding_engine
            from harrier_profile import create_harrier_engine_class, HARRIER_PROFILE
            config["embedding"].update(api_format="shiyu_harrier", model=HARRIER_PROFILE["model"],
                                        db_path=str(buckets / ".embeddings.sqlite3"))
            engine = create_harrier_engine_class(embedding_engine, endpoint=embedding_endpoint)(config)
        manager = manager_class(config, embedding_engine=engine)
        if engine is not None:
            from ombrebrain.storage.embedding_outbox import EmbeddingOutbox
            manager.attach_embedding_outbox(EmbeddingOutbox(config, manager, engine))
        return manager

    return ControlledStore(root, backend_id=backend_id, scope=scope, deployment_id=deployment_id,
                           manager_factory=factory, embedding_enabled=bool(embedding_endpoint))


def create_mcp(store):
    from mcp.server.fastmcp import FastMCP
    from mcp.server.fastmcp import server as sdk_server

    @asynccontextmanager
    async def lifespan(_server):
        try:
            await store.initialize()
            yield {}
        finally:
            await store.close()

    # Fixed mcp 1.29.0 creates Settings internally with dotenv='.env'. The
    # dedicated single-threaded service must accept only explicit constructor
    # settings, including when a launcher uses a cwd containing a .env file.
    original_settings = sdk_server.Settings
    class ExplicitSettings(original_settings):
        model_config = {**original_settings.model_config, "env_file": None, "secrets_dir": None}
        @classmethod
        def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
            return (init_settings,)
    ExplicitSettings.model_rebuild(_types_namespace=vars(sdk_server))
    try:
        sdk_server.Settings = ExplicitSettings
        server = FastMCP("shiyu-controlled-ombre", lifespan=lifespan)
    finally:
        sdk_server.Settings = original_settings

    @server.tool(structured_output=True)
    async def shiyu_memory_create(command: dict, commandDigest: str, body: str) -> dict[str, Any]:
        """Create one ordinary native memory using a trusted immutable command; never replay writes."""
        return await store.create(command, commandDigest, body)

    @server.tool(structured_output=True)
    async def shiyu_memory_get(nativeId: str, scope: str) -> dict[str, Any]:
        """Read only this deployment's exact native ID, independently verifying its durable receipt."""
        return await store.get(nativeId, scope)

    @server.tool(structured_output=True)
    async def shiyu_memory_operation_status(operationId: str, scope: str) -> dict[str, Any]:
        """Read metadata receipt and current native proof; no mutation, search, retry, or model call."""
        return await store.operation_status(operationId, scope)

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("upstream", "root", "backend-id", "scope", "deployment-id"):
        parser.add_argument("--" + name, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--embedding-endpoint", help="Pinned Harrier on literal loopback /v1/embeddings only")
    mode.add_argument("--without-embedding", action="store_true", help="Explicit exact-read-only index mode")
    args = parser.parse_args()
    # No inherited provider secrets/config are read. Avoid even incidental proxy/auth use.
    for key in list(os.environ):
        if key not in {"PATH", "TMPDIR", "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX"}:
            del os.environ[key]
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    store = create_store(upstream=args.upstream, root=args.root, backend_id=args.backend_id, scope=args.scope,
                         deployment_id=args.deployment_id, embedding_endpoint=args.embedding_endpoint)
    try:
        create_mcp(store).run(transport="stdio")
    except BaseException:
        store._dispose()
        raise


if __name__ == "__main__":
    main()
