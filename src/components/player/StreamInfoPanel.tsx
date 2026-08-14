"use client";

import { buildStreamInfoRows, type StreamInfoInput } from "@/lib/playback/stream-info";

export function StreamInfoPanel(input: StreamInfoInput) {
  const rows = buildStreamInfoRows(input);
  if (!rows.length) {
    return (
      <div className="px-2.5 py-4 text-center text-[11px] leading-snug text-white/50">
        Stream details appear once picture starts.
      </div>
    );
  }
  return (
    <dl className="divide-y divide-white/8">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-3 px-2.5 py-2"
        >
          <dt className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-white/40">
            {row.label}
          </dt>
          <dd className="min-w-0 truncate text-right text-[13px] text-white/90">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
