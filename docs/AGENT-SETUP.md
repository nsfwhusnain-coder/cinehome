# CineHome operator environment

This repository is production software for 13 household users. The server Git
tree is authoritative; developer checkouts are reviewed mirrors.

## Paths

| Item | Path |
|------|------|
| Authoritative Git/deploy tree | `hussyserver:/home/hussy/cinehome` |
| Windows working mirror | `C:\Users\husna\projects\cinehome-main` |
| Live app | `http://100.89.184.84:4445` |
| Protected backups | `/home/hussy/cinehome-backups` |
| Browser evidence | ignored `.browser-qa/` outside production images |

SSH uses the configured `hussyserver-lan`/`hussyserver` host alias. Never put a
password, PIN, cookie, storage state, API token, or rendered Compose environment
in this repository.

## Session start

```bash
ssh hussyserver
cd /home/hussy/cinehome
git status --short --branch
docker inspect --format \
  'image={{.Image}} health={{.State.Health.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' \
  cinehome
```

Read `AGENTS.md`, `CINEHOME.md`, and the latest ownership log before changing
code. Production must remain on clean server `main`; reviewed work is pushed to
a branch and fast-forwarded only after candidate validation.

## Browser QA

QA credentials and authenticated Playwright storage belong in an
operator-local mode-600 file/directory. Run browser gates from the exact
candidate or production image and mount the storage state at runtime. Never
copy `.browser-qa` into an image or leave a QA container running.

The final gate is:

```bash
bun run qa:release
```

It includes desktop/phone/TV product interaction, terminal states, adaptive
quality and tracks, Cineby-style quality/source behavior, roster recovery, and
signed-session recovery. See `CINEHOME.md` for the isolated Docker invocation.

## Safe promotion

1. Validate the exact reviewed commit with the full tests, TypeScript, a fresh
   image build, release QA, and screenshots.
2. While old production is still running, create a protected snapshot with
   `scripts/snapshot-production.sh`.
3. Fast-forward server `main` to the exact reviewed SHA.
4. Deploy with `SKIP_RSYNC=1`, `EXPECTED_REVISION`, and
   `PREDEPLOY_SNAPSHOT_DIR`.
5. Verify image revision/identity, health, database fingerprints, auth and user
   data, then repeat release QA against production.

`scripts/deploy.sh` refuses rsync, dirty/non-main source, a missing or stale
snapshot, an unexpected revision, and implicit Prisma schema changes. Its
armed rollback restores the exact prior image with `--no-build` on a failed
start, health gate, revision gate, or interrupted cutover.
