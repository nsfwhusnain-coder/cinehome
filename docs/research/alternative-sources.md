# Alternative multi-server sources (LordFlix replacement)

**Date:** 2026-07-10  
**Problem:** LordFlix city chips (Vienna, Lion, Sakura, …) come from `snowhouse.lordflix.club` + `enc-dec.app`. That path returns **0 streams** on hussyserver.

## What still works well (tested on server)

### Tier A — use these as primary

| Chip name | Backend | Why |
|-----------|---------|-----|
| **Solstice** | Vidking embed (Playwright) | Most reliable HLS capture |
| **Luna** | Vixsrc API (+ CinePro/VixSrc) | Fast TTFF, real 1080 HLS |
| **Share 1080p / 720p…** | CinePro **FshareTV** | Multi quality rungs via proxy |
| **Aether** | CinePro **Icefy** | HLS when title is covered |
| **Nest** | VidNest embed / CinePro VidNest | Modern player, good catalog |
| **Flux** | VidFast embed | Large page, live 200 |
| **Nova** | embed.su | Primary embed, stable |
| **Phoenix** | VidLink API | Multi playlist (some dead progressive) |
| **Pulse** | NoTorrent addon API | Extra path when IMDb maps |

### Tier B — solid mirrors (Playwright)

| Chip | Host (probed HTTP 200) |
|------|------------------------|
| Vienna | vidsrc.to |
| Lion | vidsrc-embed.ru |
| Sakura | vidsrc.su |
| Flower | vidsrc.rip / CinePro CineSu |
| Orion | vidsrc.me |
| Astra / Ativa | 2embed.cc / 2embed.org |
| Blaze | multiembed.mov |
| Quasar | player.videasy.net embed |
| Joy | vidjoy.pro (thin page, optional) |

### Tier C — dead / skip

- enc-dec.app Lordflix encrypt/decrypt  
- smashy.stream, autoembed.cc, moviesapi.club, primewire.tf (timeouts from server)

## CinePro OMSS (already co-located)

Image reports **14 providers**:  
`CineSu, FshareTV, Icefy, Peachify, Popr, MafiaEmbed, Tulnex, VidApi, Videasy, VidNest, VidRock, VidSrc, VidZee, VixSrc`

Coverage is **title-dependent** (Fight Club → Fshare+VixSrc; newer titles → Icefy+VixSrc).  
All play through `cinepro-core` `/v1/proxy` — good with home `/api/hls`.

## Strategy vs LordFlix UI

| LordFlix chip | CineHome substitute |
|---------------|---------------------|
| Solstice | Vidking |
| Luna | Vixsrc |
| Phoenix | VidLink |
| Vienna / Lion / Sakura | Vidsrc mirrors |
| Flower / Rio / Moscow | CineSu / Mafia / embeds |
| Multi-quality servers | CinePro Fshare Share 1080p/720p/… |

Do **not** depend on enc-dec.app. Prefer **CinePro + Vixsrc + Vidking + VidNest/VidFast + Vidsrc mirrors**.

## Ops notes

- Scraper `PROVIDER_LORDFLIX` / `PROVIDER_VIDEASY` kill switches: leave on; they no-op when enc-dec is down.
- Raise Playwright fan-out only if host RAM allows (`MAX_BROWSERS`).
- Re-probe embeds every few months — hosts rot.
