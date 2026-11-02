# Sources and dependencies

This package is part of the Shiyu workspace. It uses DSH public plugin, Session,
Agent and native client interfaces. It does not import the Lab engine or the
documentation workbench as runtime dependencies.

- DSH: DeepSeek Harness, MIT. The installed host is inspected separately from
  the historical source snapshot `ce7073d51254c26cd63b22a60835b8f948deb447`.
- `@deepseek-ai/dsh-llm` 0.2.1-rc.5 is a host-supplied peer. The native reply
  adapter uses its public `./message` export to construct complete user messages.
  The optional peer flag keeps offline development independent of a host SDK
  installation; native context operations still require the actual factory.
  No SDK source is copied or distributed in this package.
- `@modelcontextprotocol/client` 2.2.0 is a host-supplied
  optional peer for the private control-domain stdio MCP adapter. The public
  root and `./stdio` exports are used without copying or bundling SDK code.
  DSH 0.2.1-rc.5 includes this exact package in its installation dependency
  closure and maps declared linked-plugin peers. The same exact package is
  installed as a development dependency for real-SDK/synthetic-process tests;
  its dependency closure is pinned in package-lock.json, including
  `@modelcontextprotocol/core` 2.2.0. Both package manifests label the license MIT,
  while their shipped LICENSE describes an MIT-to-Apache-2.0 transition:
  consented and new code is Apache-2.0; older contributions without relicensing
  consent retain MIT; non-specification documentation is CC-BY-4.0. The MIT
  portion names Copyright (c) 2024-2025 Model Context Protocol a Series of
  LF Projects, LLC. This records the supplied materials rather than treating the
  manifest label as the complete license inventory. No SDK code or documentation
  is copied into this distribution. This is the split 2.2.0 client package,
  not the older `@modelcontextprotocol/sdk` import path. This TypeScript client
  does not itself implement an MCP server or include an Ombre installation or
  model provider. The separately packaged Python service is described below.
- Node.js `node:sqlite`: provided by the host runtime; the actual SQLite version
  and journal mode are measured when the control-store worker starts.
- The native client obtains React from the host. React is MIT-licensed.
- proper-lockfile 4.1.2 is an installed runtime dependency, licensed under MIT
  (Copyright (c) 2018 Made With MOXY Lda). Its exact package and transitive
  dependency versions are recorded in package-lock.json. License text follows
  below.
- TypeScript, tsx, Vite, Playwright and Vitest are development-only dependencies. Their
  pinned versions and transitive packages are recorded in package-lock.json.

Existing workspace plugin examples informed the DSH integration.

## Controlled Ombre service

`service/ombre/` contains Shiyu-written private stdio service code, an operation
metadata journal and a Harrier embedding-profile extension. It uses the
unmodified Ombre Brain 3.6.14 source at commit
`115d831d979bf67efc7150f976e2cb34c333c935`, licensed under MIT, Copyright (c) 2026
P0lar1zzZ. The original license is distributed at `service/ombre/LICENSE`;
`SOURCE.json` in that directory records the archive, 172-file Python source tree,
dependency lock and license hashes. The original license is 1087 bytes with CRLF
line endings; the earlier research copy uses LF. A file-specific `-text` Git
attribute preserves this license's original bytes and recorded hash. The upstream source, installed
Python environment and model weights are not distributed in the npm package.
The explicit preparation script installs fixed source and dependencies under
the ignored `.local/ombre/` directory, without modifying the downloaded source.

Python dependencies use the upstream `requirements.lock.txt` with pinned versions
and package hashes. The tested environment includes MCP Python SDK `mcp` 1.29.0
(MIT), HTTPX 0.28.1 (BSD-3-Clause), python-frontmatter 1.3.0 (MIT) and
pydantic-settings 2.14.2 (MIT). This Python dependency set is separate from the
TypeScript MCP 2.2.0 client above. Upstream dependencies present in the lock,
including OpenAI packages, do not imply that the controlled service enables
cloud generation or registers upstream server tools.

The Harrier extension subclasses the native EmbeddingEngine, retaining its
SQLite storage and ranking path while adding query/document prefixes, profile
identity, 1024-dimensional finite-vector/L2 checks and bounded loopback HTTP.
This Ombre profile truncates to the first 2000 Unicode code points before adding
prefixes; the independent TypeScript adapter rejects oversized input instead.
Model weights and llama-server identity require separate trusted-launcher
verification. The profile tests use controlled HTTP responses, and the current
Managed Runtime configuration disables embedding. Neither the tests nor the
dependency inventory establish real semantic retrieval or model-quality results.

## Superagent task core

The Shiyu runtime includes source derived from
`deepseek-ai/dsh-superagent-prototype`, fixed commit
`6337fc823ce20251c8de8085948165c81aaa701e`, under the MIT license:
Copyright (c) 2026 DeepSeek Harness Team.

The 13-file task-domain core in `src/control/tasks/upstream/` is compiled into
`dist/control/tasks/upstream/` and used through Shiyu's TaskFacade. Relative module
specifiers were adapted for NodeNext output. Local policy hooks prevent implicit
revival of ended tasks and require replacement of stopped execution instances
after verified recovery; the upstream defaults remain compatible. Exact source
URLs, Git blob SHAs, original/local SHA256 values and patches are recorded in
`src/control/tasks/upstream/SOURCE_MANIFEST.json` and `LOCAL_PATCHES.diff` in the
source repository. The SQLite transaction and task repository adapters in
`src/adapters/control-store/` also adapt the upstream Store transaction logic and
repository semantics; their source headers describe the scope and local changes.

The complete upstream copyright and MIT permission notice is distributed with
this package at `licenses/dsh-superagent-MIT.txt`. That file is an unmodified copy
of the license at the fixed upstream commit and is explicitly included by the
package's files list.

For source review, `vendor/dsh-superagent/` preserves an unmodified snapshot of
the core, test repository and barrel, eight related tests, upstream package
metadata and license. Its separate `SOURCE_MANIFEST.json` records the snapshot's
hashes and provenance. Vendor test fixtures are not production dependencies.
Original upstream tests and Shiyu integration tests provide separate evidence;
neither alone is a full-product acceptance claim.

## proper-lockfile 4.1.2 license

The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
