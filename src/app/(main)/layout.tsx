import { Navbar } from "@/components/navbar";
import { MobileDock } from "@/components/mobile-dock";
import { Footer } from "@/components/footer";
import { PageTransition } from "@/components/page-transition";
import { AmbientBackground } from "@/components/ambient-background";
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
