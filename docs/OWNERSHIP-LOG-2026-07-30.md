# CineHome ownership log — 2026-07-30

This continues the production-owner record in
`docs/OWNERSHIP-LOG-2026-07-25.md`. Times are UTC unless stated otherwise.
Secrets, media URLs, PINs, cookies, and storage-state contents are excluded.

## Authority and production state

- Authority remains `/home/hussy/cinehome`, branch `main`. The Windows tree is
  a reviewed working mirror and pushes only to `review/player-reliability`.
- Production was deliberately left on its known healthy baseline throughout
  investigation and candidate work. No candidate source was edited directly
  into the deployed tree.
- The existing rollback/restore rehearsal was rechecked before this pass. A
  new online SQLite/config/image/Git snapshot is mandatory immediately before
  promotion because live cache rows can change while users watch.
- Candidate QA uses cloned databases and runtime-mounted authenticated storage.
  Production profile defaults, progress, history, and watchlists are not test
  fixtures.

## Product findings and changes

### Player identity and recovery

- Source attempts now own a logical source ID plus generation. Destroyed engine
  callbacks, delayed media errors, and stale resolver responses cannot fail the
  current generation.
- Signed HLS HTTP 410 is handled before generic terminal failure. Refresh is
  single-flight and timer ownership is bound to the initiating attempt token.
  Repeated expiry across replacement generations has a bounded budget; actual
  playhead progress resets it. Exhaustion enters normal peer failover instead
  of producing an unbounded refresh loop.
- Session recovery QA injects 410 into a real HLS source, requires exactly one
  refresh for the normal case, proves a new nonce, rejects terminal failure
  claims against the refreshing logical source, and requires a later advancing
  decoded frame.
- Terminal errors and sleep timers record explicit pause intent before pausing.
  Native PiP user pause is preserved, while engine-owned teardown pauses are
  excluded so playing PiP failover does not incorrectly stop the replacement.
- Discarded retry, redirect, 429, and terminal upstream response bodies are
  canceled. This prevents pooled sockets and streams being stranded under
  repeated provider failure.

### Cineby-style sources and quality

- The player exposes one stable Quality / Sources / Subtitles / Audio / Speed
  sheet. The quality rail always contains Auto, 4K, 1440p, 1080p, 720p, 480p,
  360p, and 320p; unavailable rungs remain visible and disabled.
- Auto is the default unless a user saved a fixed profile quality. A one-watch
  selection never silently rewrites the profile.
- Source rows contain the complete usable roster with stable names, region
  flag or honest globe, quality badge, and premium identity. Failed/dead rows
  are removed and duplicate representations of one logical server collapse.
- Auto remains adaptive: live hls.js code never writes `currentLevel`; fixed to
  Auto explicitly releases `loadLevel`, and recovery hints are one-fragment
  hints rather than permanent manual pins or hard decoder flushes.
- Decoder dimensions are authoritative after a frame exists. If an advertised
  fixed rung does not materialize, the rail says what it fell back to. Release
  QA accepts that fallback only when the requested target is genuinely absent
  or disabled; a present 720p rung must actually decode at 720p.

### Delivered-quality truth

Real-Debrid fast trust proves transport/container viability, not decoded-track
truth. A full resolve verifies a plausible object size, a range-bounded
ISO-BMFF `ftyp` signature, and the H.264/resolution advertised by the selected
Torrentio release/file metadata before writing the one-hour trust row. Browser
QA separately records the decoded `videoWidth × videoHeight` of the stream that
actually played.

Therefore cached codec and resolution fields remain advertised/parsed metadata
until a decoded frame is observed; only the browser measurement is reported as
delivered quality. A mismatch fails over and is logged. Deeper MP4 track
parsing is deliberately deferred because another network/read step in the fast
path would increase click-to-first-frame latency.

Direct play remains preferred and the unsafe whole-file transcoder remains
disabled. 1080p and 4K are offered only when a browser-compatible direct or
adaptive source actually carries them; CineHome does not manufacture a 4K
label with upscaling.

## Candidate evidence before final promotion

- Corrected real-HLS signed-session recovery: 7/7 assertions. Four injected
  410 responses produced one HTTP-200 refresh with a fresh nonce, no terminal
  claims against the target logical source, and an advancing 1920×800 debrid
  fallback frame in 15,444 ms.
- A normal roster-recovery run also passed 7/7 with one initial exhausted
  roster, one refresh, and an advancing 1080-class frame.
- Decoder-authoritative and generation-safe focused suites passed before the
  final review. The exact final revision must still repeat the entire unit
  suite, TypeScript, fresh image build, six-gate browser release pass, broad
  resolution/playback matrices, and screenshots before this section is final.

The historical browser baseline remains:

- 21/21 playback API availability across current, old, obscure,
  international, long-running, and anime fixtures;
- 8/8 decoded browser starts;
- cold TTFF p50/p95 5,664 / 8,163 ms;
- top-ranked source actually attached 3/8;
- seek recovery 519–4,091 ms;
- forced active-source death recovered 2/3.

The immediately preceding production reference was 6/6 decoded starts and
top-ranked attachment, but TTFF regressed to 10,362 / 19,319 ms. That is
recorded as a weakness, not presented as an improvement.

## Operations, rollback, and security

- Every built image now carries
  `org.opencontainers.image.revision=<full Git SHA>`, and deployment verifies
  the running image label against an operator-supplied reviewed SHA.
- `scripts/snapshot-production.sh` creates mode-700 snapshots containing
  online backups of every live SQLite database, table counts and logical row
  fingerprints, protected env/source/resolved config, container/image
  inspection, image tag/archive, Git bundle, logs, and checksums. Restored
  rehearsal copies must pass `PRAGMA quick_check`.
- Deploy requires a fresh verified snapshot and refuses implicit Prisma schema
  drift. Cutover rollback is armed for start/health/revision failure and
  EXIT/HUP/INT/TERM. Critical rollback commands are individually checked,
  recreation uses `--no-build`, and both pre- and post-health image IDs must
  equal the saved live ID.
- The dormant Caddy configuration no longer accepts a caller-controlled
  localhost proxy port.
- Stale validation and production QA containers were inspected and removed;
  the application container and production database were not touched.

Still deliberately deferred:

- Public-facing TLS is not being improvised during a player cutover. The app is
  still plain HTTP on the Tailscale address, and Docker publishes 4445 on all
  host interfaces. Binding/TLS needs a tested access migration for all 13 users
  so a security change does not become an availability incident.
- Name+PIN auth, trusted-proxy/forwarded-header policy, non-root container
  execution, and hard CPU/RAM/PID limits need separate compatibility and load
  work. They are real weaknesses, not claims of safety.
- The legacy transcoder code remains present but `TRANSCODER_ENABLED=0` is
  enforced because its measured resource use is unsafe on this shared host.

## Final promotion record

Pending exact-final build, candidate release QA, measurements, fresh snapshot,
production cutover, post-cutover data fingerprints, and production product
pass. This section must be completed rather than replaced by “next steps.”
