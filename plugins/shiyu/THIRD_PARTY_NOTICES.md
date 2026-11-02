# Sources and dependencies

This package is part of the Shiyu workspace. It uses DSH public plugin, Session,
Agent and native client interfaces. It does not import the Lab engine or the
documentation workbench as runtime dependencies.

- DSH: DeepSeek Harness, MIT. The installed host is inspected separately from
  the historical source snapshot `ce7073d51254c26cd63b22a60835b8f948deb447`.
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

DSH-Superagent prototype source materials have been copied into
`vendor/dsh-superagent/` from `deepseek-ai/dsh-superagent-prototype`, fixed commit
`6337fc823ce20251c8de8085948165c81aaa701e`. This import contains the 13-file task
domain core, its in-memory test repository and barrel, eight related tests,
upstream package metadata, and the complete upstream MIT license (Copyright (c)
2026 DeepSeek Harness Team). Source files retain their original paths and bytes;
no upstream source patches were applied by this import. It does not connect the
upstream Engine to the Shiyu runtime.

The full license is preserved at `vendor/dsh-superagent/LICENSE`. Fixed source
URLs, Git blob SHAs, original/local SHA256 values, scope, and modification history
are recorded in `vendor/dsh-superagent/SOURCE_MANIFEST.json`. Local provenance,
dependency audit and validation files are separately identified there. The
original core baseline tests are distinct from Shiyu integration acceptance;
see `vendor/dsh-superagent/README.local.md`.

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
