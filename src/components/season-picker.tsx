"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Season {
  id: number;
  name: string;
  season_number: number;
}

interface Props {
  seasons: Season[];
  value: number;
  onChange: (season: number) => void;
}

/** TMDB season 0 is Specials — never hide it from the picker. */
export function seasonDisplayName(seasonNumber: number, name?: string): string {
  const trimmed = name?.trim() ?? "";
  if (seasonNumber === 0) {
    if (trimmed && !/^season\s*0$/i.test(trimmed)) return trimmed;
    return "Specials";
  }
  return trimmed || `Season ${seasonNumber}`;
}

export function SeasonPicker({ seasons, value, onChange }: Props) {
  const valid = seasons.filter((s) => s.season_number >= 0);

  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger
        aria-label="Select season"
        className="h-11 min-w-[7.5rem] rounded-full border-white/40 bg-white/15 text-sm text-white backdrop-blur-[4px] hover:bg-white/25"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {valid.map((s) => (
          <SelectItem key={s.id} value={String(s.season_number)}>
            {seasonDisplayName(s.season_number, s.name)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
