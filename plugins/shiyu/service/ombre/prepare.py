"""Explicit, local-only dependency preparation; never starts Ombre or a model."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from service import verified_upstream


def main():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, help="Existing CPython 3.12.16 absolute executable")
    parser.add_argument("--uv", required=True, help="Existing uv absolute executable")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    source = json.loads((here / "SOURCE.json").read_text())
    local = here.parents[1] / ".local/ombre"
    upstream = local / "upstream" / ("Ombre-Brain-" + source["commit"])
    if args.verify_only:
        verified_upstream(upstream)
        print(json.dumps({"verified": True, "commit": source["commit"]}))
        return
    for path in (args.python, args.uv):
        if not Path(path).is_absolute() or not os.access(path, os.X_OK):
            raise ValueError("Expected existing absolute executable")
    for name in ("tmp", "cache", "upstream"):
        (local / name).mkdir(parents=True, exist_ok=True)
    environment = {"PATH": "/usr/bin:/bin", "TMPDIR": str(local / "tmp"), "UV_CACHE_DIR": str(local / "cache"), "PYTHONDONTWRITEBYTECODE": "1"}
    version = subprocess.check_output([args.python, "-I", "-c", "import platform;print(platform.python_version())"], env=environment, text=True).strip()
    if version != "3.12.16":
        raise ValueError("This fixed environment requires CPython 3.12.16")
    if not upstream.exists():
        archive = local / "tmp/source.tar.gz"
        if not archive.exists():
            url = "https://codeload.github.com/P0luz/Ombre-Brain/tar.gz/" + source["commit"]
            with urllib.request.urlopen(url, timeout=60) as response, archive.open("xb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != source["archiveSha256"]:
            raise ValueError("Pinned archive hash mismatch; existing archive retained for inspection")
        with tarfile.open(archive) as package:
            package.extractall(local / "upstream", filter="data")
    verified_upstream(upstream)
    if hashlib.sha256((here / "requirements.lock.txt").read_bytes()).hexdigest() != source["requirementsLockSha256"]:
        raise ValueError("Product lock hash mismatch")
    venv = local / ".venv"
    if not venv.exists():
        subprocess.run([args.uv, "venv", "--python", args.python, str(venv)], env=environment, check=True)
    subprocess.run([args.uv, "pip", "sync", "--python", str(venv / "bin/python"), "--require-hashes", str(here / "requirements.lock.txt")], env=environment, check=True)
    print(json.dumps({"prepared": True, "commit": source["commit"], "generationCalls": 0}))


if __name__ == "__main__":
    main()
