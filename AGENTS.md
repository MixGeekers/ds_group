# DSCord contributor guidance

These instructions apply to work in this repository. Start with the root README and the package documentation for the component you are changing.

## Repository layout

- `apps/ds-group/` contains DSCord Core, the chat and administration interfaces, Bot-node integration, memory services, deployment files and tests.
- `plugins/` and `lab/` contain separately maintained components and prototypes. Preserve their files and behavior when the task does not involve them.
- `架构与设计/`, `技术候选/`, `research/` and `测试/` contain design and research material. Historical experiments describe their recorded environment and results. Consult the current implementation for supported product behavior.

## Implementation and configuration

- Inspect the current branch, worktree, remote and uncommitted changes before editing. Use an isolated worktree when parallel work would otherwise conflict.
- Follow the package's existing interfaces and directory boundaries. Keep fixes focused and preserve supported callers and existing data.
- Read runtime and dependency requirements from package manifests and deployment configuration. Document the technical reason for a required version or protocol.
- Make installation paths, data directories, server addresses, accounts and model selection configurable through the appropriate existing interface.
- Treat sample values and developer-local settings as examples. A maintainer's provider account, model choice, machine path, port or test budget does not define a product restriction.
- Keep the source, npm package and container release version consistent. Internal component and API versions may have their own documented lifecycle.
- Keep third-party licenses, copyright notices and modification notices with vendored code.

## Validation

Run the checks appropriate to the change from `apps/ds-group/`.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run test:browser
```

Use existing tests and add a targeted regression when a bug needs coverage. Changes to the native Bot integration also require the supported DSH SDK checks. Deployment and packaging changes require a clean installation or the relevant container checks.

CI and ordinary module tests use synthetic accounts and local fixtures. A live model test requires the operator's chosen provider, model and credentials, plus an explicit request to run it. Keep the selected model and observed usage in the run's local output. Report missing or incomplete evidence accurately.

## Documentation and artifacts

- Write user-facing documentation around installation, configuration, supported behavior, upgrades and troubleshooting.
- Put reusable examples and automated regression fixtures in their normal source directories.
- Keep local execution logs, credentials, personal configuration, machine-specific reports and temporary artifacts in an ignored data directory such as the package's `.local/`.
- Preserve useful existing evidence before moving or replacing historical material. Record the scope of a verification without presenting one experimental configuration as a universal requirement.
- Check links when changing document locations. Keep published archives limited to their declared contents.

## Git and release work

- Stage and review the task's own changes. Preserve unrelated and concurrent edits.
- Fetch the current remote state before synchronization. Preserve shared history and avoid destructive reset, forced push or removal of unknown files.
- Check the staged diff and generated packages for credentials, local data and unintended files before publishing.
- Report the actual commit, verification and publication outcome separately. A local artifact, a merged commit and a published version are distinct results.
