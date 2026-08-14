---
name: cinehome-deploy
description: >
  Deploy CineHome to hussyserver and verify health/smoke. Use when deploying,
  shipping, rebuild docker, or /cinehome-deploy.
---

# CineHome deploy skill

```bash
cd /Users/husnainali/cinehome
./scripts/deploy.sh
```

Verify:
```bash
ssh hussyserver 'curl -sf -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4445/'
ssh hussyserver 'docker exec cinehome curl -sf http://127.0.0.1:3030/health | head -c 400'
ssh hussyserver 'docker exec cinehome bun /app/scripts/smoke-playback.ts'
```

Optional UI check after deploy:
```bash
source ~/.grok/secrets/cinehome.env
bun scripts/browser/qa.ts screenshot / post-deploy-home
```

Never rsync `.env` or `db/`. Deploy script already excludes them.
Disk floor: `scripts/disk-preflight.sh` (≥20GB free).
