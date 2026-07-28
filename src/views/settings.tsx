"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useNavigate } from "@/hooks/use-navigate";
import { transitionView } from "@/lib/motion";
import {
  getPreferredAudioLanguage,
  syncProfilePlaybackPreferences,
} from "@/lib/player-preferences";
import type { ProfilePlaybackPreferences } from "@/lib/profile-preferences";
import {
  clearWatchedHistory,
  loadWatchedHistory,
  removeFromWatched,
  type WatchedHistoryItem,
} from "@/lib/watched-history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Save,
  Film,
  User,
  Users,
  Trash2,
  ShieldCheck,
  Github,
  Activity,
  RefreshCw,
  AlertTriangle,
  History,
  Download,
  Crown,
  Clock,
} from "lucide-react";
import { MovieCard } from "@/components/movie-card";
import {
  GlassPill,
  GlassPillSegment,
  GlassPillTabs,
} from "@/components/glass-pill";
import { useUIStore } from "@/stores/ui-store";
// Home is available via fixed nav — no second Home control under the AB lockup

interface SettingsData {
  settings: Record<string, string>;
  status: { tmdb: boolean; playbackProvider: string };
  isAdmin: boolean;
  providers: { id: string; name: string }[];
}

interface CircuitSnapshot {
  state: "closed" | "open" | "half_open";
  enabled: boolean;
  samples: number;
  errors: number;
  errorRate: number;
  openedAt: number | null;
  openUntil: number | null;
  lastMs: number | null;
  lastAt: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

interface SystemStatusData {
  ok: boolean;
  db: "ok" | "error";
  scraper: "ok" | "error";
  scraperHealth: {
    ok: boolean;
    browsers?: number;
    queued?: number;
    pool?: { size: number; max: number; queued: number; warming: boolean };
    circuits?: Record<string, CircuitSnapshot>;
    lastScrape?: {
      at: number;
      key: string;
      fast: boolean;
      totalMs: number;
    } | null;
    logLevel?: string;
    error?: string;
  } | null;
  proxy: {
    hits: number;
    misses: number;
    errors: number;
    hitRate: number;
    entries: number;
    bytesCached: number;
    maxEntries: number;
    maxBytes: number;
  };
}

const ACCENT_COLORS: { id: string; label: string; hex: string }[] = [
  { id: "crimson", label: "Crimson", hex: "#e50914" },
  { id: "blue", label: "Blue", hex: "#3b82f6" },
  { id: "green", label: "Green", hex: "#22c55e" },
  { id: "purple", label: "Purple", hex: "#a855f7" },
];

type SettingsTab = "preferences" | "watched";

/** Designed loading state matching the settings layout — no bare spinner. */
function SettingsSkeleton() {
  return (
    <div className="min-h-screen px-4 pb-12 pt-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-40 rounded-lg" />
            <Skeleton className="h-4 w-64 rounded" />
          </div>
          <Skeleton className="h-12 w-52 rounded-full" />
        </div>
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    </div>
  );
}

/** Fires `.prompt()` on the deferred `beforeinstallprompt` event — only visible while it's live. */
function InstallAppSection() {
  const installPrompt = useUIStore((s) => s.installPrompt);
  const setInstallPrompt = useUIStore((s) => s.setInstallPrompt);
  const [installing, setInstalling] = useState(false);

  if (!installPrompt) return null;

  const install = async () => {
    setInstalling(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      // The captured event can only be used once regardless of outcome.
      setInstallPrompt(null);
      setInstalling(false);
    }
  };

  return (
    <Card className="rounded-2xl border-white/10 bg-white/[0.04] backdrop-blur-xl">
      <CardHeader>
        <CardTitle className="font-display text-base">Install app</CardTitle>
        <CardDescription>
          Add Absolute Cinema to your home screen for a full-screen, app-like experience.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          size="sm"
          className="rounded-full"
          onClick={() => void install()}
          disabled={installing}
        >
          {installing ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-4 w-4" />
          )}
          Install app
        </Button>
      </CardContent>
    </Card>
  );
}

export function SettingsView() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<SettingsTab>("preferences");

  const { data, isLoading } = useQuery<SettingsData>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="font-display">Sign in required</CardTitle>
            <CardDescription>You need to sign in to access settings.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate("/login")}>Sign in</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return <SettingsSkeleton />;
  }

  const isAdmin = data.isAdmin;

  return (
    <div className="min-h-screen px-4 pb-12 pt-24 sm:px-6 lg:px-8">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionView}
        className={tab === "watched" ? "mx-auto max-w-7xl space-y-6" : "mx-auto max-w-3xl space-y-6"}
      >
        {/* Clear of fixed nav (h-72 + brand); no second Home under the AB lockup */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Settings
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {tab === "watched"
                ? "Titles you’ve marked as already watched"
                : "Playback preferences and account options"}
            </p>
          </div>
          <GlassPillTabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "preferences", label: "Preferences" },
              { value: "watched", label: "Already watched" },
            ]}
          />
        </div>

        {tab === "watched" ? (
          <WatchedHistorySection />
        ) : (
          <>
        {/* User account info */}
        <Card className="rounded-2xl border-white/10 bg-white/[0.04] backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="font-display text-base">Your Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <User className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium">{session.user?.name}</div>
                <div className="text-xs text-muted-foreground">{isAdmin ? "Admin" : "Member"}</div>
              </div>
              <Badge variant={isAdmin ? "default" : "secondary"}>{isAdmin ? "Admin" : "Member"}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <GlassPill>
                <GlassPillSegment onClick={() => navigate("/watchlist")}>
                  View my list
                </GlassPillSegment>
                <GlassPillSegment onClick={() => setTab("watched")}>
                  <History className="mr-1.5 h-3.5 w-3.5" />
                  Already watched
                </GlassPillSegment>
                <GlassPillSegment onClick={() => navigate("/login")}>
                  Switch user
                </GlassPillSegment>
              </GlassPill>
            </div>
          </CardContent>
        </Card>

        {/* Available to every signed-in user */}
        <InstallAppSection />
        <PlaybackPreferencesSection />

        {isAdmin ? (
          <>
            <Separator />
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Admin</p>

            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="font-display text-base">Service Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <StatusRow
                  label="TMDB API"
                  ok={data.status.tmdb}
                  okLabel="Configured"
                  badLabel="Missing API key"
                />
                <StatusRow
                  label="Playback provider"
                  ok={true}
                  okLabel={
                    data.providers.find((p) => p.id === data.status.playbackProvider)?.name ||
                    data.status.playbackProvider
                  }
                  badLabel=""
                />
              </CardContent>
            </Card>

            <SystemHealthSection />

            <RealDebridSection />

            <TmdbSection initial={data.settings.tmdb_api_key || ""} />

            <PlaybackProviderSection providers={data.providers} initial={data.status.playbackProvider} />

            <AppearanceSection initialAccent={data.settings.accent_color || "crimson"} />

            <FeatureFlagsSection
              initial={{
                flag_ui_bottom_nav: data.settings.flag_ui_bottom_nav || "on",
                flag_ui_hubs: data.settings.flag_ui_hubs || "on",
                flag_playback_fast_path: data.settings.flag_playback_fast_path || "on",
              }}
            />

            <UserManagementSection />
          </>
        ) : null}

        {/* About */}
        <Card className="rounded-2xl border-white/10 bg-white/[0.04] backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="font-display text-base">About</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>Absolute Cinema — personal, ad-free streaming UI.</div>
            <div className="flex flex-wrap gap-3">
              <a
                href="https://www.themoviedb.org/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-red-400 hover:underline"
              >
                <Film className="h-3.5 w-3.5" /> TMDB
              </a>
              <a
                href="https://www.justwatch.com/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-red-400 hover:underline"
              >
                JustWatch
              </a>
              <a
                href="https://github.com"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-red-400 hover:underline"
              >
                <Github className="h-3.5 w-3.5" /> GitHub
              </a>
            </div>
          </CardContent>
        </Card>
          </>
        )}
      </motion.div>
    </div>
  );
}

function StatusRow({ label, ok, okLabel, badLabel }: { label: string; ok: boolean; okLabel: string; badLabel: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      {ok ? (
        <Badge className="bg-primary/15 text-primary hover:bg-primary/20">
          <CheckCircle2 className="h-3 w-3 mr-1" /> {okLabel}
        </Badge>
      ) : (
        <Badge variant="secondary">
          <XCircle className="h-3 w-3 mr-1" /> {badLabel}
        </Badge>
      )}
    </div>
  );
}

/** Per-device playback defaults — used by video-player on next play. */
function PlaybackPreferencesSection() {
  const [qualityOverride, setQualityOverride] = useState<string | null>(null);
  const [audioLanguageOverride, setAudioLanguageOverride] = useState<string | null>(null);

  const preferencesQuery = useQuery<ProfilePlaybackPreferences>({
    queryKey: ["profile-playback-preferences"],
    queryFn: async () => {
      const response = await fetch("/api/preferences", { cache: "no-store" });
      const json = (await response.json()) as ProfilePlaybackPreferences & {
        error?: string;
      };
      if (!response.ok) throw new Error(json.error || "Could not load preferences");
      syncProfilePlaybackPreferences(json);
      return json;
    },
  });

  const quality =
    qualityOverride ?? String(preferencesQuery.data?.playbackQuality ?? "auto");
  const audioLang =
    audioLanguageOverride ??
    preferencesQuery.data?.audioLanguage ??
    getPreferredAudioLanguage();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playbackQuality: quality === "auto" ? "auto" : Number(quality),
          audioLanguage: audioLang.trim() || "en",
        }),
      });
      const json = (await response.json()) as ProfilePlaybackPreferences & {
        error?: string;
      };
      if (!response.ok) throw new Error(json.error || "Could not save preferences");
      return json;
    },
    onSuccess: (preferences) => {
      syncProfilePlaybackPreferences(preferences);
      setQualityOverride(String(preferences.playbackQuality));
      setAudioLanguageOverride(preferences.audioLanguage);
      toast.success("Playback preferences saved to your profile");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not save preferences");
    },
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display text-base">Playback preferences</CardTitle>
        <CardDescription>
          Auto is the default and adapts to your connection. Choose a fixed default only
          when you want every title to start at that quality. You can still change quality
          for the current video without changing this profile setting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="pref-quality">Playback quality</Label>
          <Select value={quality} onValueChange={setQualityOverride}>
            <SelectTrigger id="pref-quality" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto — best for your connection</SelectItem>
              <SelectItem value="2160">Ultra — 4K when available</SelectItem>
              <SelectItem value="1440">Higher — 1440p when available</SelectItem>
              <SelectItem value="1080">High — 1080p</SelectItem>
              <SelectItem value="720">Balanced — 720p</SelectItem>
              <SelectItem value="480">Data saver — 480p</SelectItem>
              <SelectItem value="360">Minimum data — 360p</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pref-audio">Preferred audio language</Label>
          <Select value={audioLang} onValueChange={setAudioLanguageOverride}>
            <SelectTrigger id="pref-audio" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="es">Spanish</SelectItem>
              <SelectItem value="fr">French</SelectItem>
              <SelectItem value="de">German</SelectItem>
              <SelectItem value="hi">Hindi</SelectItem>
              <SelectItem value="ja">Japanese</SelectItem>
              <SelectItem value="ko">Korean</SelectItem>
              <SelectItem value="pt">Portuguese</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          size="sm"
          className="rounded-full"
          disabled={!preferencesQuery.isSuccess || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-4 w-4" />
          )}
          Save preferences
        </Button>
        {preferencesQuery.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Could not load your profile preferences. Reload this page before saving.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Full My-List-style grid of already-watched titles (localStorage). Only shown from Settings. */
function WatchedHistorySection() {
  const navigate = useNavigate();
  const [items, setItems] = useState<WatchedHistoryItem[]>([]);
  const [filter, setFilter] = useState<"all" | "movie" | "tv">("all");

  useEffect(() => {
    setItems(loadWatchedHistory());
  }, []);

  const refresh = () => setItems(loadWatchedHistory());

  const filtered = items.filter((i) => filter === "all" || i.mediaType === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Mark titles with ✓ on My List. They stay here until you remove them.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {items.length > 0 ? (
            <GlassPillTabs
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "movie", label: "Movies" },
                { value: "tv", label: "TV" },
              ]}
            />
          ) : null}
          {items.length > 0 ? (
            <GlassPill>
              <GlassPillSegment
                onClick={() => {
                  clearWatchedHistory();
                  refresh();
                  toast.success("Watched list cleared");
                }}
              >
                Clear all
              </GlassPillSegment>
            </GlassPill>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-6 py-16 text-center backdrop-blur-xl">
          <History className="mx-auto mb-3 h-10 w-10 text-white/40" />
          <p className="text-sm text-muted-foreground">
            Nothing marked yet. On My List, tap the green check on a poster.
          </p>
          <div className="mt-4 flex justify-center">
            <GlassPill>
              <GlassPillSegment onClick={() => navigate("/watchlist")}>
                Open My List
              </GlassPillSegment>
            </GlassPill>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {filtered.map((item) => (
            <div key={`${item.mediaType}-${item.tmdbId}`} className="group relative">
              <MovieCard
                movie={{
                  id: item.tmdbId,
                  title: item.title,
                  poster_path: item.poster ?? null,
                  backdrop_path: item.backdrop,
                  vote_average: item.voteAverage ?? undefined,
                  release_date: item.releaseDate,
                }}
                forceMediaType={item.mediaType as "movie" | "tv"}
                className="w-full"
                hideWatchlist
                hideOverflowMenu
              />
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeFromWatched(item.tmdbId, item.mediaType);
                  refresh();
                  toast.success("Removed from watched");
                }}
                className="absolute right-2 top-2 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-white/25 bg-black/75 text-white shadow-md backdrop-blur-md transition-colors hover:border-destructive/50 hover:bg-destructive hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove ${item.title} from already watched`}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function circuitBadgeVariant(
  snap: CircuitSnapshot
): { label: string; className: string } {
  if (!snap.enabled) {
    return { label: "disabled", className: "bg-muted text-muted-foreground" };
  }
  if (snap.state === "open") {
    return { label: "open", className: "bg-destructive/15 text-destructive" };
  }
  if (snap.state === "half_open") {
    return { label: "half-open", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  }
  return { label: "closed", className: "bg-primary/15 text-primary" };
}

function SystemHealthSection() {
  const { data, isLoading, isFetching, refetch, isError } = useQuery<SystemStatusData>({
    queryKey: ["system-status"],
    queryFn: async () => {
      const res = await fetch("/api/system-status", { cache: "no-store" });
      // 503 still returns a body with partial health
      const json = (await res.json()) as SystemStatusData;
      return json;
    },
    refetchInterval: 15_000,
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="font-display flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Provider &amp; proxy health
          </CardTitle>
          <CardDescription>
            Live scraper circuits/pool and HLS proxy cache metrics (refreshes every 15s).
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full shrink-0"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh health"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading && !data ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError && !data ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Could not load system status.
          </p>
        ) : data ? (
          <>
            <div className="space-y-2">
              <StatusRow
                label="Database"
                ok={data.db === "ok"}
                okLabel="OK"
                badLabel="Error"
              />
              <StatusRow
                label="Stream scraper"
                ok={data.scraper === "ok"}
                okLabel="Reachable"
                badLabel={data.scraperHealth?.error || "Unreachable"}
              />
            </div>

            {data.scraperHealth?.pool && (
              <div>
                <h3 className="text-sm font-medium mb-2">Browser pool</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricTile
                    label="Browsers"
                    value={`${data.scraperHealth.pool.size}/${data.scraperHealth.pool.max}`}
                  />
                  <MetricTile label="Queued" value={String(data.scraperHealth.pool.queued)} />
                  <MetricTile
                    label="Warming"
                    value={data.scraperHealth.pool.warming ? "yes" : "no"}
                  />
                  <MetricTile
                    label="Log level"
                    value={data.scraperHealth.logLevel || "—"}
                  />
                </div>
              </div>
            )}

            {data.scraperHealth?.circuits && (
              <div>
                <h3 className="text-sm font-medium mb-2">Provider circuits</h3>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Provider</th>
                        <th className="px-3 py-2 font-medium">State</th>
                        <th className="px-3 py-2 font-medium">Samples</th>
                        <th className="px-3 py-2 font-medium">Err rate</th>
                        <th className="px-3 py-2 font-medium">Last ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(data.scraperHealth.circuits).map(([id, snap]) => {
                        const badge = circuitBadgeVariant(snap);
                        return (
                          <tr key={id} className="border-b border-border last:border-0">
                            <td className="px-3 py-2 font-medium capitalize">{id}</td>
                            <td className="px-3 py-2">
                              <Badge className={badge.className}>{badge.label}</Badge>
                            </td>
                            <td className="px-3 py-2 tabular-nums">
                              {snap.errors}/{snap.samples}
                            </td>
                            <td className="px-3 py-2 tabular-nums">
                              {Math.round(snap.errorRate * 100)}%
                            </td>
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">
                              {snap.lastMs != null ? `${snap.lastMs}ms` : "—"}
                              {snap.lastOk === false && snap.lastError ? (
                                <span className="block truncate max-w-[10rem] text-[10px] text-destructive">
                                  {snap.lastError}
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.scraperHealth?.lastScrape && (
              <p className="text-xs text-muted-foreground">
                Last scrape:{" "}
                <span className="text-foreground tabular-nums">
                  {data.scraperHealth.lastScrape.totalMs}ms
                </span>
                {data.scraperHealth.lastScrape.fast ? " (fast)" : ""} ·{" "}
                {data.scraperHealth.lastScrape.key} ·{" "}
                {new Date(data.scraperHealth.lastScrape.at).toLocaleString()}
              </p>
            )}

            <div>
              <h3 className="text-sm font-medium mb-2">HLS proxy cache</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricTile
                  label="Hit rate"
                  value={`${Math.round(data.proxy.hitRate * 100)}%`}
                />
                <MetricTile
                  label="Hits / misses"
                  value={`${data.proxy.hits} / ${data.proxy.misses}`}
                />
                <MetricTile label="Upstream errors" value={String(data.proxy.errors)} />
                <MetricTile
                  label="Cached"
                  value={`${formatBytes(data.proxy.bytesCached)} · ${data.proxy.entries} entries`}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Cap: {data.proxy.maxEntries} entries / {formatBytes(data.proxy.maxBytes)} (process-local).
              </p>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

interface RealDebridStatusData {
  configured: boolean;
  source: "database" | "env" | "none";
  valid: boolean;
  premium: boolean;
  username: string | null;
  expiresAt: string | null;
  points: number | null;
  accountType: string | null;
  error: string | null;
}

function formatDaysLeft(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  return `${days} day${days === 1 ? "" : "s"} left`;
}

function formatExpiryDate(expiresAt: string | null): string {
  if (!expiresAt) return "—";
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Owner's Real-Debrid premium subscription — live status + in-UI token update (admin only). */
function RealDebridSection() {
  const qc = useQueryClient();
  const [token, setToken] = useState("");

  const { data: status, isLoading, isFetching, refetch } = useQuery<RealDebridStatusData>({
    queryKey: ["debrid-status"],
    queryFn: async () => {
      const res = await fetch("/api/debrid/status");
      if (!res.ok) throw new Error("Failed to load status");
      return res.json();
    },
  });

  const applyStatus = (next: RealDebridStatusData) => {
    qc.setQueryData(["debrid-status"], next);
    qc.invalidateQueries({ queryKey: ["debrid-status"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/debrid/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to save token");
      return json as RealDebridStatusData;
    },
    onSuccess: (next) => {
      toast.success(next.premium ? "Real-Debrid connected — premium active" : "Token saved");
      setToken("");
      applyStatus(next);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save token"),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/debrid/status", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to remove token");
      return json as RealDebridStatusData;
    },
    onSuccess: (next) => {
      toast.success("Removed saved token");
      applyStatus(next);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove token"),
  });

  const active = Boolean(status?.valid && status?.premium);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="font-display flex items-center gap-2 text-base">
            <Crown className="h-4 w-4 text-amber-400" /> Real-Debrid Premium
          </CardTitle>
          <CardDescription>
            Premium 1080p/4K sources from your own Real-Debrid subscription.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded-full"
          aria-label="Refresh status"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !status ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm">Subscription</span>
              {active ? (
                <Badge className="bg-amber-500/15 text-amber-400 hover:bg-amber-500/20">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Active · Premium
                </Badge>
              ) : status.configured ? (
                <Badge variant="secondary">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  {status.valid ? "Not premium" : "Token invalid"}
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <XCircle className="mr-1 h-3 w-3" /> Not connected
                </Badge>
              )}
            </div>

            {active ? (
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-amber-500/15 bg-amber-500/[0.04] p-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Account</div>
                  <div className="font-medium">{status.username ?? "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Points</div>
                  <div className="font-medium">{status.points ?? "—"}</div>
                </div>
                <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Expires</span>
                  <span className="font-medium">{formatExpiryDate(status.expiresAt)}</span>
                  <span className="text-xs text-muted-foreground">
                    ({formatDaysLeft(status.expiresAt)})
                  </span>
                </div>
              </div>
            ) : status.error ? (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                {status.error}
              </p>
            ) : !status.configured ? (
              <p className="text-sm text-muted-foreground">
                No token yet — paste your Real-Debrid API token below to enable premium sources.
              </p>
            ) : null}

            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="rd-token">{status.configured ? "Update token" : "API token"}</Label>
              <Input
                id="rd-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  status.configured
                    ? "Paste a new token to replace"
                    : "Paste your Real-Debrid API token"
                }
              />
              <p className="text-xs text-muted-foreground">
                Get it from <code className="rounded bg-muted px-1">real-debrid.com/apitoken</code>.
                Validated before saving; never shown again.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => save.mutate()}
                disabled={save.isPending || token.trim().length === 0}
                size="sm"
                className="rounded-full"
              >
                {save.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-1 h-4 w-4" />
                )}
                {status.configured ? "Update" : "Connect"}
              </Button>
              {status.source === "database" ? (
                <Button
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                  size="sm"
                  variant="ghost"
                  className="rounded-full text-muted-foreground"
                >
                  {remove.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1 h-4 w-4" />
                  )}
                  Remove
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TmdbSection({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdb_api_key: value }),
      });
      if (!res.ok) throw new Error("Failed to save");
    },
    onSuccess: () => {
      toast.success("TMDB API key saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: () => toast.error("Failed to save"),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display flex items-center gap-2 text-base">
          <Film className="h-4 w-4 text-primary" /> TMDB API Key
        </CardTitle>
        <CardDescription>
          Used for posters, metadata, and search. The key from{" "}
          <code className="px-1 rounded bg-muted">.env</code> takes precedence if set.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="tmdb-key">API Key (optional override)</Label>
          <Input
            id="tmdb-key"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Leave blank to use .env value"
          />
          <p className="text-xs text-muted-foreground">
            Get a free key at <code className="px-1 rounded bg-muted">themoviedb.org/settings/api</code>
          </p>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending} size="sm" className="rounded-full">
          {save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function PlaybackProviderSection({
  providers,
  initial,
}: {
  providers: { id: string; name: string }[];
  initial: string;
}) {
  const [value, setValue] = useState(initial);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async (next: string) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playback_provider: next }),
      });
      if (!res.ok) throw new Error("Failed to save");
    },
    onSuccess: () => {
      toast.success("Playback provider updated");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: () => toast.error("Failed to save"),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display text-base">Playback Provider</CardTitle>
        <CardDescription>Where Absolute Cinema resolves a stream URL from when you hit Play.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select
          value={value}
          onValueChange={(v) => {
            setValue(v);
            save.mutate(v);
          }}
        >
          <SelectTrigger className="w-full rounded-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The scraper provider uses a local Playwright service to pull direct stream URLs from public
          embed sources. Switch to &quot;Not configured&quot; to disable playback entirely.
        </p>
      </CardContent>
    </Card>
  );
}

type FlagKey = "flag_ui_bottom_nav" | "flag_ui_hubs" | "flag_playback_fast_path";

const FLAG_META: {
  key: FlagKey;
  label: string;
  description: string;
  refreshHint?: boolean;
}[] = [
  {
    key: "flag_ui_bottom_nav",
    label: "Mobile bottom dock",
    description:
      "When off, the fixed mobile dock is hidden and search is available from the top bar.",
    refreshHint: true,
  },
  {
    key: "flag_ui_hubs",
    label: "Movies / Shows hubs",
    description:
      "When off, Movies and Shows links are hidden from primary nav (routes still work if bookmarked).",
    refreshHint: true,
  },
  {
    key: "flag_playback_fast_path",
    label: "Playback fast path",
    description:
      "When off, /api/playback ignores client fast=1 and always does a full resolve (slower cold start).",
  },
];

function FeatureFlagsSection({
  initial,
}: {
  initial: Record<FlagKey, string>;
}) {
  const [flags, setFlags] = useState(initial);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async (patch: Partial<Record<FlagKey, string>>) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to save");
      return patch;
    },
    onSuccess: (patch) => {
      const needsRefresh = Object.keys(patch).some(
        (k) => FLAG_META.find((m) => m.key === k)?.refreshHint
      );
      toast.success(
        needsRefresh
          ? "Feature flag updated — refresh to apply layout"
          : "Feature flag updated"
      );
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: () => toast.error("Failed to save"),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display text-base">Feature flags</CardTitle>
        <CardDescription>
          Server-wide UI and playback switches. Layout chrome re-reads on the next page load
          (cached ~30s).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {FLAG_META.map((meta) => (
          <div key={meta.key} className="space-y-1.5">
            <Label htmlFor={meta.key}>{meta.label}</Label>
            <Select
              value={flags[meta.key]}
              onValueChange={(v) => {
                setFlags((prev) => ({ ...prev, [meta.key]: v }));
                save.mutate({ [meta.key]: v });
              }}
            >
              <SelectTrigger id={meta.key} className="w-full rounded-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">On (default)</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{meta.description}</p>
          </div>
        ))}
        <p className="text-xs text-muted-foreground border-t border-border pt-3">
          Scraper provider kill switches (<code className="rounded bg-muted px-1">PROVIDER_*=0</code>
          ) live in env / compose and require a container restart — not toggled here.
        </p>
      </CardContent>
    </Card>
  );
}

function AppearanceSection({ initialAccent }: { initialAccent: string }) {
  const { theme, setTheme } = useTheme();
  const [accent, setAccent] = useState(initialAccent);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async (color: string) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accent_color: color }),
      });
      if (!res.ok) throw new Error("Failed to save");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const applyAccent = (color: { id: string; hex: string }) => {
    setAccent(color.id);
    document.documentElement.style.setProperty("--primary", color.hex);
    document.documentElement.style.setProperty("--ring", color.hex);
    save.mutate(color.id);
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display text-base">Appearance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="theme-select">Theme</Label>
          <Select value={theme} onValueChange={setTheme}>
            <SelectTrigger id="theme-select" className="w-full rounded-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <fieldset className="space-y-1.5 border-0 p-0 m-0">
          <legend className="text-sm font-medium leading-none p-0">Accent color</legend>
          <div className="flex gap-2">
            {ACCENT_COLORS.map((c) => (
              <button
                key={c.id}
                onClick={() => applyAccent(c)}
                title={c.label}
                aria-label={c.label}
                className="h-8 w-8 rounded-full ring-offset-2 ring-offset-background transition-all"
                style={{
                  backgroundColor: c.hex,
                  boxShadow: accent === c.id ? `0 0 0 2px ${c.hex}` : undefined,
                }}
              />
            ))}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}

function UserManagementSection() {
  const qc = useQueryClient();
  const { data: usersList, isLoading } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) return [];
      return res.json() as Promise<
        {
          id: string;
          name: string;
          isAdmin: boolean;
          createdAt: string;
          watchlistCount: number;
          progressCount: number;
        }[]
      >;
    },
  });

  const deleteUser = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/users?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: () => toast.error("Failed to delete user"),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="font-display flex items-center gap-2 text-base">
          <Users className="h-4 w-4 text-primary" /> Family Members
        </CardTitle>
        <CardDescription>Everyone who has signed up. Delete a user to wipe their watchlist and progress.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : usersList && usersList.length > 0 ? (
          <div className="space-y-2">
            {usersList.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-sm font-semibold">
                  {u.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{u.name}</span>
                    {u.isAdmin && (
                      <Badge variant="default" className="text-[10px] py-0 px-1.5">
                        <ShieldCheck className="h-3 w-3 mr-0.5" /> Admin
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.watchlistCount} in watchlist · {u.progressCount} in progress
                  </div>
                </div>
                {!u.isAdmin && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deleteUser.isPending}
                        aria-label={`Delete ${u.name}`}
                        title={`Delete ${u.name}`}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete {u.name}&apos;s account?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently deletes {u.name}&apos;s account, including their
                          watchlist ({u.watchlistCount} {u.watchlistCount === 1 ? "item" : "items"})
                          and watch progress ({u.progressCount} {u.progressCount === 1 ? "item" : "items"}).
                          This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteUser.mutate(u.id)}
                          className="bg-destructive text-white hover:bg-destructive/90"
                        >
                          Delete account
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No users yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
