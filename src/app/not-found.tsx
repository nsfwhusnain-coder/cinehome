import Link from "next/link";
import { Film } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/**
 * Root fallback for any URL that matches no route at all (outside the
 * (main)/(watch) segments, which have their own not-found.tsx keeping chrome).
 */
export default function RootNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <BrandMark size="lg" />
      <Film className="h-10 w-10 text-muted-foreground" aria-hidden />
      <div>
        <h1 className="font-display text-xl font-semibold">Page not found</h1>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          That page doesn&apos;t exist, or the link is broken.
        </p>
      </div>
      <Link href="/" className={cn(buttonVariants({ size: "lg" }), "rounded-full px-6")}>
        Back to Home
      </Link>
    </div>
  );
}
