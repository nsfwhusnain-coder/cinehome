import Link from "next/link";
import { Film } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Catches notFound() calls from inside the (main) group (e.g. an unknown
 * /browse/[category] slug) and unmatched routes under it. Renders inside
 * MainLayout so Navbar/Footer/MobileDock stay on screen.
 */
export default function MainNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 pt-20 text-center">
      <Film className="h-10 w-10 text-muted-foreground" aria-hidden />
      <div>
        <h1 className="font-display text-xl font-semibold">Nothing here</h1>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          That title or category doesn&apos;t exist, or the link is broken.
        </p>
      </div>
      <Link href="/" className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}>
        Back to Home
      </Link>
    </div>
  );
}
