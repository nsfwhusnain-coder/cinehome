# CineHome HLS Edge Proxy (Cloudflare Worker)

Moves **video segment delivery** off the home server onto Cloudflare’s edge.

## Security

- **No open proxy.** Every request needs a signed token.
- Tokens are minted only by CineHome **after the user signs in** (`/api/playback` → auth).
- HMAC-SHA256 with shared secret (`PROXY_SECRET` / `WORKER_PROXY_SECRET`).
- Tokens expire (~3h, capped by session).
- Private IP hosts are blocked.

## Free tier

- Workers Free: **100,000 requests/day**.
- Household under ~10k/day is fine.
- Auth-gated; not for public unauthenticated traffic.

## Deploy

```bash
# 1. Login (browser)
cd workers/hls-proxy
npx wrangler login

# 2. Deploy
npx wrangler deploy

# 3. Set secret (use the SAME value as WORKER_PROXY_SECRET on the server)
openssl rand -base64 32
npx wrangler secret put PROXY_SECRET

# 4. Note the URL, e.g.
#    https://cinehome-hls-proxy.<account>.workers.dev
```

## CineHome server `.env`

```bash
WORKER_PROXY_ENABLED=1
WORKER_PROXY_BASE=https://cinehome-hls-proxy.<account>.workers.dev
WORKER_PROXY_SECRET=<same-as-PROXY_SECRET>
NEXT_PUBLIC_WORKER_PROXY_HOST=cinehome-hls-proxy.<account>.workers.dev
```

Then rebuild/restart CineHome:

```bash
cd /home/hussy/cinehome
docker compose build && docker compose up -d
```

## Verify

```bash
curl -sS https://cinehome-hls-proxy.<account>.workers.dev/health
# {"ok":true,"service":"cinehome-hls-proxy"}

# Without token → 401
curl -sS "https://cinehome-hls-proxy.<account>.workers.dev/?t=nope"
```

Sign in to CineHome, play a title — Network tab should show segment URLs on `workers.dev` (not only `/api/hls/...` on the home IP).

## Fallback

If Worker env vars are **not** set, CineHome keeps using local `/api/hls` (previous behaviour).
