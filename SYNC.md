# Fork sync runbook (`rezenderaul/opencode`)

`dev` mirrors `upstream/dev` (`anomalyco/opencode`) byte-for-byte. All fork
work lives on `custom/*` branches rebased weekly onto the mirror.

Never commit to `dev`. `SYNC.md` lives on `custom/*` so the mirror stays clean.

## Weekly sync

Run from a clean tree on this branch:

```bash
git fetch upstream
git checkout dev
git merge --ff-only upstream/dev
git push origin dev
git checkout custom/resilience-v0
git rebase dev
```

If the rebase conflicts: resolve in favor of keeping the patch minimal and
linked to its upstream issue (see `openspec/changes/fork-terminal-wsl-resiliente/tasks.md`
6.3). Never resolve by absorbing upstream refactors into the patch.

## Verify

```bash
test "$(git rev-parse dev)" = "$(git rev-parse upstream/dev)" && echo MIRROR_OK
git log --oneline dev..custom/resilience-v0
```

Every entry in the second command must reference its upstream issue/PR.
Entries merged upstream get dropped, not ported.
