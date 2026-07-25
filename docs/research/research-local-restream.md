# Local Restream / Re-encode Options — CineHome Server

**Date:** 2026-07-09  
**Target host:** CineHome box (Ubuntu/CasaOS) — Ryzen 7 4800H + GTX 1660 Ti  
**Constraints:** Jellyfin + Plex already co-resident · disk ~75% full · household concurrent users (1–3)  
**App context:** CineHome scrapes remote HLS, proxies via `/api/hls/[sessionId]` with in-memory segment cache (~512 MB, session TTL ~25 m)

---

## Executive summary

For **this** machine, the ranking is not “what self-hosters do in general” — it is what fits **disk pressure + existing CineHome HLS path + GPU already present**.

| Rank | Option | Verdict for this server |
|------|--------|-------------------------|
| **1** | Hybrid: direct proxy if CDN healthy, local restream if slow | **Best** — minimal new disk, reuses existing player |
| **2** | Harden existing HLS proxy (deeper buffer / disk segment cache / retry) | **Cheapest win** — no re-encode, no new stack |
| **3** | ffmpeg restream → local HLS (single 720p, NVENC if needed) | **Strong** when re-encode or remux is required |
| **4** | *arr download → play local via Jellyfin/Plex/CineHome file path | **Good quality** but **conflicts with 75% disk** |
| **5** | Jellyfin/Plex live transcode of remote (if they can ingest URL) | **Use sparingly** — competes with CineHome for NVENC |
| **6** | MediaMTX / nginx-rtmp full ladder | **Overkill** for household VOD scrape traffic |

---

## Hardware snapshot (this server)

### CPU — Ryzen 7 4800H
- Zen 2, **8c/16t**, mobile H-series.
- PassMark multi ~**15 000** (ballpark).
- Plex rule-of-thumb: ~**2000** PassMark per 1080p software full-transcode → roughly **5–7× 1080p→720p** concurrent **if the box did nothing else**.
- Reality: CineHome scraper (Playwright), Docker, Jellyfin, Plex already share the CPU. Treat CPU encode as **1–2 streams max** before UX degrades.

### GPU — GTX 1660 Ti (Turing)
- **NVENC** (Turing): strong H.264/HEVC encode quality vs older Pascal; fine for 720p/1080p household restream.
- **NVDEC**: handles typical scraper codecs (H.264/HEVC) for decode-side of transcodes.
- Consumer concurrent NVENC cap: historically 2–3; modern drivers commonly allow **up to 8** encode sessions system-wide (still one chip — throughput is the real limit). Household needs **1–2 simultaneous encodes** → **no patch required**.
- VRAM 6 GB: more than enough for 2–3 simultaneous 1080p→720p pipelines.
- **Prefer NVENC for any live restream/re-encode.** Leave CPU free for scraper + Next.js + *arr.

### Disk — ~75% full
- Deploy already has preflight abort when free on `/` **&lt; 20 GB**.
- Any “cache whole movie” design **must** have:
  - hard size cap (e.g. 20–40 GB LRU),
  - TTL / watched-purge,
  - single-quality default (no full ABR ladder on disk by default).

---

## Storage math — 2 h movie at 720p

Formula: `size_GB ≈ bitrate_Mbps × hours × 0.45`  
(more precisely: `Mbps × 3600 × hours / 8 / 1024`)

| Profile | Video + audio | ~Size for 2 h | Notes |
|---------|---------------|---------------|--------|
| 480p “smooth” | ~1.0–1.5 Mbps + 96 k AAC | **0.9–1.4 GB** | Emergency ladder rung |
| 720p lean | ~2.0–2.5 Mbps + 128 k | **1.8–2.3 GB** | Good LAN quality |
| 720p comfortable | ~3.0–4.0 Mbps + 160 k | **2.7–3.6 GB** | Default recommendation |
| 1080p mid | ~5–8 Mbps | **4.5–7.2 GB** | Usually unnecessary for LAN |
| HLS ladder 480+720 | both rungs | **~3–5 GB** | 1.5–2× single rung |
| Remux only (copy, no re-encode) | source bitrate | **source size** | Often **4–15 GB+** if upstream is high-bitrate |

**Disk budget implication at 75% full:**

| Policy | Concurrent full-movie caches | Approx footprint |
|--------|------------------------------|------------------|
| 5 × 720p lean | 5 titles | ~10 GB |
| 10 × 720p comfortable | 10 titles | ~30 GB |
| 10 × dual ladder | 10 titles | ~40–50 GB |

**Recommendation:** cap restream/VOD cache at **20–30 GB total**, **1 quality (720p)**, LRU by last play. Do **not** keep full dual ladders permanently.

HLS packaging overhead vs progressive MP4: typically **+5–15%** (segment headers + playlists). Negligible vs bitrate choice.

---

## Problem framing for CineHome

Upstream failure modes:

1. **Flaky CDN** — stalls, 429, short-lived segment URLs, TLS resets  
2. **High bitrate source** — fine on server WAN, rough on weak client Wi‑Fi  
3. **Auth-bound / session-bound segments** — already handled by session-scoped proxy  
4. **Seek / multi-device** — remote may not tolerate parallel segment storms  

CineHome already:

- Scrapes → returns `streamUrl`  
- Proxies HLS through **session-scoped** rewrite + **~512 MB RAM** segment cache + prefetch (~8 segments)  
- Player: hls.js  

Gap: RAM cache is **session-bound and small**. It smooths short blips; it does **not** survive long upstream outages, multi-hour rewatches without re-fetch, or true “download once, watch offline on LAN.”

---

## Option deep dives

### A. Hybrid: direct if fast CDN, restream if slow  ★ Rank 1

**Idea:** Measure upstream health at play start (and periodically). Route accordingly.

| Path | When | Behavior |
|------|------|----------|
| **Direct proxy** (current) | CDN OK: low latency, steady segment pace, few errors | `/api/hls/...` only; optional deeper buffer |
| **Local restream** | High error rate, bitrate &gt; threshold, buffer underruns | Start ffmpeg (or download-ahead worker); player switches to local m3u8 |
| **Local file** | Title already in *arr library | Serve from disk (Jellyfin/Plex or static file URL) |

**Health signals (simple, effective):**

- Segment fetch p95 latency  
- Error rate over last N segments (timeouts, 4xx/5xx)  
- Estimated available throughput vs declared playlist bitrate  
- Client-reported buffer stalls (player → API)

**Threshold sketch (tune after baseline):**

- Switch to restream if: error rate ≥ 10% over 20 segments **or** 2+ underruns in 60 s **or** measured throughput &lt; 1.5× selected rung bitrate  
- Prefer remux/`-c copy` restream first; re-encode only if client cannot play source codec or bitrate must drop

**Pros for this server**

- Default path costs almost nothing (disk/CPU/GPU idle)  
- Matches household reality: many titles stream fine; only bad sources need help  
- Reuses existing player URL shape  

**Cons**

- Needs a small control plane (worker + session state + switch API)  
- Mid-stream switch can glitch unless you crossfade/replace source carefully (start restream early in background before swap)

**Feasibility:** **High.** Best ROI for CineHome specifically.

---

### B. Harden existing HLS proxy (no re-encode)  ★ Rank 2

**Idea:** Keep copy-passthrough; make the proxy a **reliable local edge**.

Enhancements (ordered by value):

1. **Disk-backed segment cache** (not only RAM) — e.g. `/var/cache/cinehome-hls` with **5–15 GB** LRU  
2. **Longer session / watch-window TTL** while playback heartbeats (extend past 25 m for movies)  
3. **Aggressive retry + multi-source failover** at segment layer  
4. **Larger prefetch window** when free disk/RAM allow (e.g. 30–60 s ahead)  
5. **Optional full progressive pull** of remaining segments after play starts (“download while watching”) into the same LRU

**Pros**

- No quality loss, no NVENC contention with Jellyfin/Plex  
- Fixes flaky CDN better than anything that still re-hits origin every few seconds without cache  
- Disk cost controllable  

**Cons**

- Does **not** fix “source is 15 Mbps HEVC and living-room Wi‑Fi can’t take it” without a lower rung  
- Auth-bound segments must stay session-scoped (you already do this — keep it)

**Feasibility:** **Very high.** Natural extension of `hls-proxy.ts` / KD11 cache policy. Prefer this **before** building MediaMTX.

---

### C. ffmpeg restream → local HLS (ladder 480/720)  ★ Rank 3

**Idea:** `scrape once → pull upstream → write local HLS → player hits LAN only`.

#### Modes

| Mode | ffmpeg | Latency to first play | Disk | Quality |
|------|--------|----------------------|------|---------|
| **C1 Remux HLS** | `-c copy` → HLS segments | Near-live (seconds) | = source rate | Bit-identical |
| **C2 Live re-encode** | NVENC → 720p (optional 480p) | 5–20 s head-start | Fixed bitrate | Slight loss |
| **C3 Full VOD cache** | Encode whole file first | Minutes–tens of min | Fixed | Best for rewatch |

#### Recommended ladder for **this** box (if re-encoding)

| Rung | Resolution | Video bitrate | Audio | Encoder |
|------|------------|---------------|-------|---------|
| 720p | 1280×720 | **3000 k** | AAC 128 k | `h264_nvenc` |
| 480p | 854×480 | **1200 k** | AAC 96 k | `h264_nvenc` |

**Default policy under disk pressure:** generate **720p only**. Add 480p only if a weak client is detected.

#### Example skeleton (NVENC single-rung restream)

```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda \
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -i "$UPSTREAM_M3U8" \
  -c:v h264_nvenc -preset p4 -tune ll -rc vbr -cq 23 -b:v 3M -maxrate 3.5M -bufsize 6M \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 4 -hls_list_size 0 -hls_playlist_type event \
  -hls_segment_filename "/var/cache/cinehome-restream/%v/seg_%05d.ts" \
  "/var/cache/cinehome-restream/%v/index.m3u8"
```

Notes:

- For pure remux: drop hwaccel/nvenc; use `-c copy` (fails if codec/container incompatible with HLS client).  
- `-hls_playlist_type event` grows the playlist as content arrives → good for “watch while filling.”  
- On complete: rewrite to `vod` playlist or keep progressive file.  
- **Purge** when idle / LRU.

#### GPU vs CPU for this workload

| Workload | GTX 1660 Ti NVENC | 4800H libx264 |
|----------|-------------------|---------------|
| Realtime 1080p→720p | **Easy**, multi-stream | Possible, steals scraper CPU |
| Dual ladder 480+720 one title | **Fine** (1 encode session per rung or filter_complex) | Painful under load |
| Concurrent household (2 titles re-encode) | **OK** | Risky with Docker+scraper |
| Idle power / heat | Low dedicated encode engine | Heats chassis, fans |

**Verdict:** **Always prefer NVENC** on this host for re-encode restream. Use CPU only as fallback if GPU is locked by multi-session Jellyfin/Plex thrash (rare for household).

#### “Scrape once → ffmpeg HLS cache → play local” feasibility

| Question | Answer |
|----------|--------|
| Technically feasible? | **Yes** |
| Good default for every title? | **No** — disk 75% full; many scrapes are one-shot |
| Good for flaky/high-bitrate titles? | **Yes** |
| Start delay if full-file first? | Bad UX (5–30+ min) |
| Start delay if restream while playing? | **Acceptable** (buffer 15–30 s then play) |
| Legal/ToS | Same as existing scrape model; still personal household — no multi-tenant CDN cache of third-party content beyond personal use |

**Recommended shape:** **play-ahead restream** (C1/C2), not overnight full library encode.

---

### D. *arr stack + stream local files  ★ Rank 4

**Idea:** Sonarr/Radarr (+ qBittorrent/SABnzbd) acquire release → Jellyfin/Plex (or CineHome file backend) direct-plays.

| Aspect | Assessment |
|--------|------------|
| Playback smoothness | **Best** (LAN direct play, no CDN) |
| Disk | **Worst fit** at 75% — typical movie 2–15 GB each |
| Start latency | High if not already downloaded |
| Ops | Already common self-host pattern; you may already have pieces |
| Fit with CineHome UI | Needs “library hit?” check before scrape |

**When to use:**

- Repeat watches / family favorites  
- Shows where scrape sources are chronically bad  
- Off-peak download, watch later  

**When not to:**

- “I clicked play and want it now” for random one-offs  
- Disk free space near the 20 GB deploy floor  

**Mitigations if used:**

- Quality profile capped (e.g. 720p / max 3–4 GB movies)  
- Aggressive media management (delete after watch, unmonitor)  
- Separate mount if possible (external disk) so `/` stays healthy  

---

### E. Jellyfin / Plex as transcoder for remote  ★ Rank 5

**Idea:** Hand URL or intermediate file to Jellyfin/Plex; let their HW transcode pipeline serve clients.

| Aspect | Assessment |
|--------|------------|
| HW path | Both can use **1660 Ti NVENC** well |
| Integration | CineHome is **not** a Plex client — glue is awkward |
| Overlap | Competes with same GPU as option C; two stacks thrashing NVENC is worse |
| Strength | Mature client ecosystem if household already uses Plex apps on TVs |

**Verdict:** Prefer **CineHome-owned ffmpeg worker** for scrape-sourced titles (one control plane). Use Jellyfin/Plex as the **library** path for *arr files, not as the scrape restream engine.

---

### F. MediaMTX / nginx-rtmp  ★ Rank 6

**MediaMTX** strengths: protocol bridge (RTSP/RTMP/WebRTC/HLS), pull remote HLS and re-publish, recording.

**nginx-rtmp** strengths: classic ingest → HLS; heavier legacy feel.

| Use case | Fit for CineHome VOD scrape |
|----------|-----------------------------|
| Live IPTV restream to many LAN clients | Good |
| One-off movie from scraped m3u8 | **Overkill** |
| Adaptive ladder + auth integration with Next session model | Extra moving parts |
| Disk recording of live | Useful; duplicates option C |

**Verdict:** Only adopt MediaMTX if you later add **live TV / camera / multi-protocol** needs. For movie/TV scrape playback, **ffmpeg + static HLS dir + existing proxy** is simpler and disk-clearer.

---

## Hybrid architecture (recommended target)

```
Player (hls.js)
    │
    ▼
CineHome playback API
    │
    ├─ library hit? ──► local file / Jellyfin URL  (Rank 4 path)
    │
    ├─ scrape → upstream m3u8
    │     │
    │     ├─ health OK ──► existing HLS proxy (+ disk segment cache)   Rank 2
    │     │
    │     └─ health BAD / too fat ──► restream worker
    │              │
    │              ├─ try remux (-c copy) HLS local
    │              └─ else NVENC 720p HLS local
    │                       │
    └───────────────────────┴──► player uses /api/hls/local/... or static cache URL
```

**Worker rules for this host:**

1. Max **2** concurrent restream jobs (household + headroom).  
2. Prefer **GPU**; queue on CPU only if NVENC busy.  
3. Cache root size hard cap **20–30 GB**; LRU; delete on “watched + idle 24h.”  
4. Default **one rung (720p @ ~3 Mbps)** → ~**2.7 GB / 2 h**.  
5. Never restream if free disk &lt; **25 GB** (align with deploy 20 GB floor + margin).  
6. Heartbeat from player extends cache TTL; abandon job if client gone &gt; 2 min and no other viewers.

---

## Ranked recommendations (this server only)

### 1 — Hybrid direct/restream (build this)
- **Why #1:** Matches flaky-vs-good reality; protects disk and GPU.  
- **Effort:** Medium (health metrics + worker + player source swap).  
- **Hardware:** NVENC only on demand.  

### 2 — Disk-backed HLS segment cache + longer play session
- **Why #2:** Lowest risk extension of current `hls-proxy` / session design.  
- **Effort:** Low–medium.  
- **Hardware:** None.  
- **Disk:** 5–15 GB LRU.  

### 3 — ffmpeg local HLS restream (remux first, NVENC 720p second)
- **Why #3:** Real answer when CDN is trash or bitrate is silly.  
- **Effort:** Medium.  
- **Hardware:** 1660 Ti shines.  
- **Disk:** ~2–4 GB per active title; cap total.  

### 4 — *arr → local library for favorites
- **Why not higher:** Disk 75% full.  
- **Use for:** intentional library, not default play path.  
- **If disk grows (external):** becomes co-#1 for quality.  

### 5 — Jellyfin/Plex transcode path for scrape URLs
- Skip as primary; keep for native library clients only.  

### 6 — MediaMTX / nginx-rtmp ladder server
- Skip unless live multi-protocol needs appear.  

---

## GPU vs CPU — decision table

| Scenario | Choice | Reason |
|----------|--------|--------|
| Live restream re-encode 720p | **NVENC** | Realtime, low CPU, scraper stays responsive |
| Dual ladder 480+720 one job | **NVENC** (2 encodes or split) | 4800H should not carry this |
| Remux `-c copy` | **CPU negligible** | No encode; just demux/mux + disk I/O |
| 2 concurrent household restreams | **NVENC** | Within consumer session limits |
| Jellyfin already HW-transcoding 2 streams | Queue or remux-only | Avoid encode thrash |
| Overnight library compress | Optional **NVENC** CQ | Offline; don’t block interactive |

Turing NVENC quality at ~3 Mbps 720p is **good enough for living-room**; x264 slow would win quality-per-bit but not worth CPU on this multi-role box.

---

## Storage cost summary (planning numbers)

| Item | Size |
|------|------|
| 2 h 720p restream @ 3 Mbps | **~2.7 GB** |
| 2 h 720p @ 2.5 Mbps | **~2.3 GB** |
| 2 h 480p @ 1.2 Mbps | **~1.1 GB** |
| 2 h dual ladder 1.2+3.0 | **~3.8 GB** |
| Recommended cache pool | **20–30 GB** (≈ 7–10 movies lean, or 5–7 comfortable) |
| Proxy segment disk cache | **5–15 GB** separate or shared pool |
| Abort restream if free &lt; | **25 GB** |

At **75% full**, treat every full-movie cache as **expensive**. Prefer **sliding window** (keep last N minutes + download-ahead) over retaining full titles after watch.

---

## Implementation priority (practical sequence)

1. **Baseline:** log segment latency/errors on current HLS proxy for a week (even simple counters).  
2. **Disk segment cache + heartbeat TTL** on existing proxy.  
3. **Restream worker** (remux → NVENC fallback) behind a feature flag.  
4. **Player hybrid switch** using health signals.  
5. **Optional:** “Add to library” → *arr only when user opts in / free space OK.  
6. **Do not** deploy MediaMTX or dual permanent ladders until (1–4) prove insufficient.

---

## Out of scope / non-goals for this host

- Multi-tenant public CDN caching of third-party streams  
- 4K restream ladders (disk + encode cost unjustified for household LAN)  
- CPU-only x264 slow library for “max quality” (wrong machine for that)  
- Unlimited full-title archive of every scrape  

---

## Sources / grounding

- CineHome SoT: HLS proxy session cache (~512 MB RAM, session TTL ~25 m), stream-scraper, deploy disk preflight (&lt;20 GB free aborts)  
- Plex CPU guidelines (PassMark per resolution full-transcode)  
- NVIDIA NVENC consumer session limits (raised over years; household 1–2 streams fine on 1660 Ti)  
- Industry 720p streaming sizes (~1.5–3 GB / 2 h depending on bitrate)  
- MediaMTX docs (HLS pull/proxy — powerful, heavier than needed for VOD scrape)  
- Self-host patterns: ffmpeg HLS restream, *arr + local play, Plex/Jellyfin NVENC  

---

## Bottom line

On **Ryzen 4800H + GTX 1660 Ti, disk 75% full, Jellyfin/Plex already present**:

1. **Do not** default to “download entire movie then play.”  
2. **Do** hybrid: keep direct proxy when CDN is healthy; restream locally when it is not.  
3. **Do** use **NVENC** for any re-encode; keep ladder to **720p-only** under disk pressure (~**2.5–3 GB per 2 h film**).  
4. **Do** add a **capped** disk cache (proxy segments + restream output).  
5. **Use *arr** for intentional library titles only, not as the scrape fix.  
6. **Skip MediaMTX** until you need live multi-protocol routing.
