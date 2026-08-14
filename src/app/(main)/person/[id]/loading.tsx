export default function Loading() {
  return (
    <div className="min-h-screen px-4 pb-12 pt-24 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 md:flex-row">
        <div className="h-40 w-40 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="flex-1 space-y-3">
          <div className="h-8 w-56 max-w-full animate-pulse rounded-lg bg-muted" />
          <div className="h-4 w-full max-w-xl animate-pulse rounded bg-muted" />
          <div className="h-4 w-5/6 max-w-lg animate-pulse rounded bg-muted" />
          <div className="mt-4 h-11 w-40 animate-pulse rounded-full bg-muted" />
        </div>
      </div>
    </div>
  );
}
