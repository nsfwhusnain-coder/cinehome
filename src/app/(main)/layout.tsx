import dynamic from "next/dynamic";
import { Navbar } from "@/components/navbar";

/**
 * Below-the-fold and decorative chrome, split out of the first load.
 *
 * The sign-in screen sits inside this group and paid for all of it: a mobile
 * dock it never shows, a footer below the fold, and an ambient colour wash that
 * only has something to tint once there is artwork on screen. None of it is
 * needed to paint a name field and a PIN field, and the cost lands hardest on
 * the television, where parsing the bundle is the most expensive thing that
 * happens before a user can type.
 */
const MobileDock = dynamic(() => import("@/components/mobile-dock").then((m) => m.MobileDock));
const Footer = dynamic(() => import("@/components/footer").then((m) => m.Footer));
import { PageTransition } from "@/components/page-transition";
// No ssr:false here — this layout is an async Server Component and Next
// rejects that option outside a client component. The chunk still splits.
const AmbientBackground = dynamic(() => import("@/components/ambient-background").then((m) => m.AmbientBackground));
import { isBottomNavEnabled, isHubsEnabled } from "@/lib/feature-flags";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const [bottomNavEnabled, hubsEnabled] = await Promise.all([
    isBottomNavEnabled(),
    isHubsEnabled(),
  ]);

  return (
    <div className="relative min-h-screen flex flex-col text-foreground">
      <AmbientBackground />
      <Navbar bottomNavEnabled={bottomNavEnabled} hubsEnabled={hubsEnabled} />
      {/*
        pb-20 clears the fixed mobile bottom dock (h-16 + safe-area) so content and
        footer never sit under the bar. No-op when flag is off or on desktop (dock is md:hidden).
      */}
      <div
        className={
          bottomNavEnabled
            ? "relative z-10 flex flex-1 flex-col pb-20 md:pb-0"
            : "relative z-10 flex flex-1 flex-col"
        }
      >
        <main className="flex-1">
          <PageTransition>{children}</PageTransition>
        </main>
        <Footer />
      </div>
      {bottomNavEnabled ? <MobileDock hubsEnabled={hubsEnabled} /> : null}
    </div>
  );
}
