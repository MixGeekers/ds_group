#!/usr/bin/env python3
"""Verify vendored bytes and the core import closure without importing upstream code."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / "SOURCE_MANIFEST.json").read_text())
audit = json.loads((ROOT / "DEPENDENCY_AUDIT.json").read_text())
errors = []
for record in manifest["files"]:
    path = ROOT / record["path"]
    if not path.is_file():
        errors.append(f"missing: {record['path']}")
        continue
    raw = path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()
    blob_sha = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    if sha256 != record["localSha256"]:
        errors.append(f"local SHA256 mismatch: {record['path']}")
    if not record["localModifications"]:
        if sha256 != record["upstreamSha256"] or blob_sha != record["upstreamGitBlobSha"]:
            errors.append(f"unmodified upstream bytes mismatch: {record['path']}")

def dependencies(path):
    text = (ROOT / path).read_text()
    matches = re.findall(
        r'''\bfrom\s+['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]|^\s*import\s*['"]([^'"\n]+)['"]''',
        text,
        re.M,
    )
    return sorted({value for match in matches for value in match if value})

for record in audit["files"]:
    if dependencies(record["path"]) != record["imports"]:
        errors.append(f"import audit stale: {record['path']}")
    missing = sorted(
        str(((ROOT / record["path"]).parent / dep).resolve().relative_to(ROOT))
        for dep in record["imports"]
        if dep.startswith(".") and not ((ROOT / record["path"]).parent / dep).is_file()
    )
    if missing != record["missingRelativeImports"]:
        errors.append(f"missing-dependency audit stale: {record['path']}")

graph = {record["path"]: record["imports"] for record in audit["files"]}
seen, pending, external = set(), ["src/core/engine.ts"], set()
while pending:
    path = pending.pop()
    if path in seen:
        continue
    seen.add(path)
    for dep in graph[path]:
        if dep.startswith("."):
            target = str(((ROOT / path).parent / dep).resolve().relative_to(ROOT))
            if target not in graph:
                errors.append(f"core import absent from audit: {target}")
            else:
                pending.append(target)
        else:
            external.add(dep)
if sorted(seen) != audit["coreClosure"]["files"]:
    errors.append("core closure changed")
if sorted(external) != audit["coreClosure"]["externalImports"]:
    errors.append("core external dependencies changed")
if errors:
    raise SystemExit("\n".join(errors))
print(f"Verified {len(manifest['files'])} upstream files; {len(seen)}-file core closure; external: {', '.join(sorted(external))}.")
print("Static verification only; no upstream source, package scripts or test suites were executed.")
