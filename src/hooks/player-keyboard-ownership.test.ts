/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Exactly one module may own player keyboard shortcuts.
 *
 * `use-player-gestures.ts` once attached a second capture-phase window keydown
 * listener handling the same keys as `video-player.tsx`, so every shortcut ran
 * twice. Space toggled play and then immediately paused again — reported as
 * "space does nothing but the play button works", because a click fires once.
 * Arrows seeked 20s instead of 10 and f/m cancelled themselves out.
 *
 * The failure is completely silent: no error, no type error, no failing test.
 * This asserts the ownership boundary directly against the sources so a future
 * hook cannot quietly re-introduce a competing listener.
 */
const ROOT = join(import.meta.dir, "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function countWindowKeydownListeners(source: string): number {
  return source.match(/window\.addEventListener\(\s*["']keydown["']/g)?.length ?? 0;
}

describe("player keyboard shortcut ownership", () => {
  it("keeps the gestures hook free of keyboard listeners", () => {
    expect(countWindowKeydownListeners(read("hooks/use-player-gestures.ts"))).toBe(0);
  });

  it("keeps exactly one keyboard owner in the player", () => {
    expect(countWindowKeydownListeners(read("components/video-player.tsx"))).toBe(1);
  });

  it("still binds the shortcuts the gestures hook used to own", () => {
    const player = read("components/video-player.tsx");
    // Play/pause, seek, fullscreen, mute, subtitles, episodes, audio+subs.
    for (const key of ['case " ":', 'case "k":', 'case "j":', 'case "l":', 'case "f":', 'case "m":', 'case "c":', 'case "e":', 'case "s":']) {
      expect(player).toContain(key);
    }
    // Shift+seek was only in the removed copy; it must survive the merge.
    expect(player).toContain("e.shiftKey ? -30 : -10");
    expect(player).toContain("e.shiftKey ? 30 : 10");
  });
});
