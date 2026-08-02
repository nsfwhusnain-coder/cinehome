# Random-access remux playback

Large MKV/WebM releases are remuxed into a live fMP4 HLS playlist. The worker
does not download a whole film before playback: it stays ahead of the viewer at
a bounded rate. Consequently, the browser cannot seek to a position the active
playlist has not generated yet.

The random-access path fixes that without forcing whole-file preloading:

1. The browser keeps a logical title timeline using TMDB's runtime while the
   worker playlist is growing.
2. Resume or an out-of-range scrub requests `startAt=<logical offset>` with a
   six-second preroll.
3. The worker input-seeks before opening the source, preserves video bit-for-bit,
   converts the selected original/English audio track to stereo AAC, and emits
   the same fMP4 EVENT playlist as the deployed path.
4. The player prewarms the new manifest, changes over only when it is ready,
   and verifies the first displayed frame lands within two seconds of the
   requested logical position. A failed handoff returns to the prior offset.

Cache identity includes source, selected audio policy, normalized offset, and
the remux pipeline version. Offset entries are bounded by the existing idle,
per-job, total-cache, free-space, and two-job concurrency limits. They are not
treated as whole-title cache entries.

Set `NEXT_PUBLIC_PLAYBACK_RANDOM_ACCESS_REMUX=0` and rebuild to return to the
legacy grow-from-zero behavior. `REMUX_ENABLED=0` remains the server-side kill
switch for remuxing as a whole.
