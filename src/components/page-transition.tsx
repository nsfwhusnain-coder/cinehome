"use client";

import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { transitionContent } from "@/lib/motion";
import { useIsTv } from "@/hooks/use-is-tv";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isTv = useIsTv();

  /**
   * Televisions get the navigation without the crossfade. Animating opacity
   * and a transform across the whole page means compositing the entire
   * viewport for the length of the transition — on a 4K panel that is 8.3
   * million pixels per frame, on the weakest GPU the app runs on, at exactly
   * the moment the next route is also being built. It is the single most
   * visible stall in the interface and it buys a flourish nobody sitting three
   * metres away is looking for.
   */
  if (isTv) return <>{children}</>;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={transitionContent}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
