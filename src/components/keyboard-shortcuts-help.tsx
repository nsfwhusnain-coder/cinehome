"use client";

import { Fragment } from "react";
import { useUIStore } from "@/stores/ui-store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const GLOBAL_SHORTCUTS = [{ key: "?", desc: "Show this help" }];

const PLAYER_SHORTCUTS = [
  { key: "Space / K", desc: "Play / pause" },
  { key: "J / ←", desc: "Back 10s" },
  { key: "L / →", desc: "Forward 10s" },
  { key: "0-9", desc: "Jump to 0%-90%" },
  { key: "F", desc: "Fullscreen" },
  { key: "M", desc: "Mute" },
  { key: "↑ / ↓", desc: "Volume up / down" },
  { key: "C", desc: "Toggle subtitles" },
  { key: "N", desc: "Next episode" },
];

export function KeyboardShortcutsHelp() {
  const open = useUIStore((s) => s.shortcutsHelpOpen);
  const setOpen = useUIStore((s) => s.setShortcutsHelpOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md rounded-2xl border-white/10 bg-popover/80 backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle className="font-display">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ShortcutGroup title="Global" items={GLOBAL_SHORTCUTS} />
          <ShortcutGroup title="Player" items={PLAYER_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutGroup({ title, items }: { title: string; items: { key: string; desc: string }[] }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {items.map((s) => (
          <Fragment key={s.key}>
            <kbd className="justify-self-start rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
              {s.key}
            </kbd>
            <span className="text-sm text-muted-foreground">{s.desc}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
