import { DetailPageSkeleton } from "@/components/skeletons";

/**
 * page.tsx awaits tmdb.movieDetails() server-side before rendering — without
 * this, that await blocks navigation with no visual feedback. DetailView's
 * own client-side skeleton never gets a chance to show until after this.
 */
export default function Loading() {
  return (
    <div className="min-h-screen pb-12">
      <DetailPageSkeleton />
    </div>
  );
}
