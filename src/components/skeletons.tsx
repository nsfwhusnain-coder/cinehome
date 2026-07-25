import { Skeleton } from "@/components/ui/skeleton";

export function HeroSkeleton() {
  return (
    <Skeleton
      className="w-full rounded-none"
      style={{ height: "clamp(680px, 92vh, 1040px)" }}
    />
  );
}

export function MovieCardSkeleton({ variant = "poster" }: { variant?: "poster" | "backdrop" }) {
  return (
    <Skeleton
      className={
        variant === "poster"
          ? "aspect-[2/3] w-[150px] shrink-0 rounded-[10px] sm:w-[170px] md:w-[190px]"
          : "aspect-video w-[240px] shrink-0 rounded-xl md:w-[320px]"
      }
    />
  );
}

export function MovieRowSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="space-y-3">
      <Skeleton className="ml-14 h-6 w-48" />
      <div className="flex gap-4 overflow-hidden pl-14">
        {Array.from({ length: count }).map((_, i) => (
          <MovieCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Mirrors DetailContent's real layout: full-bleed backdrop with a bottom-left
 * logo/meta/overview/actions stack (no poster box — the loaded page has none)
 * plus the desktop-only floating info aside and a below-the-fold rail.
 */
export function DetailPageSkeleton() {
  return (
    <div>
      <div className="relative h-[62vh] min-h-[420px] w-full sm:h-[75vh] sm:min-h-[520px]">
        <Skeleton className="absolute inset-0 h-full w-full rounded-none" />

        <div className="absolute inset-x-0 bottom-0 px-4 pb-8 sm:px-6 sm:pb-12 lg:px-8 lg:pb-16">
          <div className="flex max-w-4xl flex-col gap-4 pr-0 sm:pr-56">
            <Skeleton className="h-10 w-2/3 max-w-[420px] rounded-lg sm:h-14" />
            <div className="flex flex-wrap gap-2.5">
              <Skeleton className="h-4 w-10 rounded" />
              <Skeleton className="h-4 w-14 rounded" />
              <Skeleton className="h-4 w-8 rounded" />
            </div>
            <Skeleton className="h-4 w-1/2 max-w-sm rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-full max-w-xl rounded" />
              <Skeleton className="h-4 w-5/6 max-w-lg rounded" />
            </div>
            <div className="mt-1 flex items-center gap-2.5">
              <Skeleton className="h-11 w-32 rounded-full" />
              <Skeleton className="h-[38px] w-[38px] rounded-full" />
            </div>
          </div>
        </div>

        <Skeleton className="absolute bottom-8 right-4 hidden h-40 w-52 rounded-2xl sm:bottom-12 sm:right-6 sm:block lg:right-8" />
      </div>

      <div className="relative z-10 space-y-3 px-4 pt-12 sm:px-6 lg:px-8">
        <Skeleton className="h-6 w-32 rounded" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video w-[200px] shrink-0 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SearchResultsSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl" />
      ))}
    </div>
  );
}

export function PlayerSkeleton() {
  return <Skeleton className="aspect-video w-full rounded-xl" />;
}
