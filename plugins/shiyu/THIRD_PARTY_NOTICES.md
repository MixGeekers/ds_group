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
