# Per-task workspace with a writable shared-workspace hard-link mirror

Module: `src/adapters/artifacts/shared-workspace.ts` (task-67). Status: **implemented and
offline-verified (G1)**; not wired into Runtime/TaskRunner in this slice. Artifact publication is
unchanged (`<taskId>/artifacts` is still only written by `LocalArtifactStore`).

## Layout

```
{workspacesRoot}/
  .shared-workspaces/
    lock.json                     exclusive single-writer lock (lease, stale takeover)
    index.json                    shared index updated on consistent publish/rollback
  <taskId>/
    task/                         task-private working directory
    shared/                       hard-link mirror of the configured shared root (files only)
    .workspace-manifest.json      pre-task manifest + integrity hash
    .workspace-report.json        last publish/blocked receipt
    .workspace-snapshot/          optional pre-task snapshot (APFS clone/copy) for rollback
    artifacts/                    unchanged LocalArtifactStore area (untouched by this module)
```

## Writable semantics (disclosed, not hidden)

- `shared/` mirrors **files only**, by hard link; directories are recreated. Files and canonical
  source share one inode (`nlink=2` while the task mirror exists).
- An in-place write through `<taskId>/shared/<file>` immediately changes the canonical shared file.
  This is the requested writable-shared-workspace behavior. `publishTaskWorkspace` records the
  change in the shared index only when the path is declared in `expectedChanges`; an undeclared
  modification is an unexpected conflict (task `unknown`), and the shared index is not advanced.
- New files created under `shared/` are published into the canonical root by a controlled hard link
  and recorded; they are never silently discarded. On conflicts the task mirror is retained for
  explicit owner reconciliation; `discardTaskWorkspace` removes only task-side links.
- Deleting a shared file defaults to removing the task-side link only (`task-link-removed`).
  Deleting the canonical file requires an explicit `ownerDecision:{kind:'delete-shared', paths,
  decisionId}`; nothing is deleted silently.
- Consistent publish updates `index.json`; `unknown`/`blocked` leaves the index unchanged. External
  replacement of a canonical inode, missing canonical files, symlinks, cross-device roots and
  external hard-link aliases fail closed before publishing.
- Optional `snapshot: true` copies the pre-task shared files (APFS clone when supported, otherwise
  copy). `rollbackTaskWorkspace` restores canonical bytes in place when the inode is unchanged,
  rebuilds the index and releases the lock.

## Consistency and limits

- Single-writer assumption (user-approved serial execution) enforced by an exclusive lock file
  (`O_EXCL`, lease with one stale takeover attempt). The lock is advisory for other processes; a
  second module instance cannot enter, but an external editor that ignores the lock is treated as an
  external change by the post-task diff where detectable.
- Same-file-system requirement: cross-device mirroring is rejected (`CROSS_DEVICE`); no cross-device
  copy fallback.
- `dev/ino/nlink/size/mtimeMs/sha256` are captured per file in `.workspace-manifest.json`, which also
  carries a `manifestSha256` integrity hash. A modified manifest is blocked (`MANIFEST_TAMPERED`).
- Bounds: file count/depth/file size; symlinks and non-regular files are rejected.
- Limitations (do not over-claim): the manifest integrity hash is tamper-evident, not
  cryptographic authentication — a malicious same-UID process can rewrite the manifest and its
  checksum. `expectedChanges` captures the task's declared intent; an external writer that ignores
  the advisory lock and rewrites the same canonical inode cannot be distinguished from the task (the
  lock is advisory, not an OS-enforced sandbox). APFS-clone snapshot support depends on the target
  filesystem; unsupported filesystems fall back to a full copy.

## Integration point (not applied)

`LocalTaskRunner` currently uses `artifacts.prepareWorkspace(taskId)` (returns `<taskId>`) as the
worker cwd. A future patch would prepare `<taskId>/task` as the worker cwd and call
`prepareTaskWorkspace`/`publishTaskWorkspace` around the Task execution (with `expectedChanges` from
the accepted plan and an explicit owner decision for deletion). This slice intentionally does not
edit `runtime.ts`/`index.ts`.

## Evidence

`artifacts/dsh/tasks/workspace-shared-hardlink.json` (layout, disclosure, matrix cases, fingerprints,
zero-live-host boundaries, full-check verification).
