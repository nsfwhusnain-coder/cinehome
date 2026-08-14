"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Navbar } from "@/components/navbar";
import { PageTransition } from "@/components/page-transition";

const MobileDock = dynamic(() => import("@/components/mobile-dock").then((m) => m.MobileDock));
const Footer = dynamic(() => import("@/components/footer").then((m) => m.Footer));
const AmbientBackground = dynamic(() =>
  import("@/components/ambient-background").then((m) => m.AmbientBackground)
);

interface MainChromeProps {
  children: React.ReactNode;
  bottomNavEnabled: boolean;
  hubsEnabled: boolean;
}

/**
 * Login sits in the (main) group but must not pay for dock, footer, or extra
 * bottom padding. Path-aware so we do not move /login out of this layout.
 */
export function MainChrome({ children, bottomNavEnabled, hubsEnabled }: MainChromeProps) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";
  const showDock = bottomNavEnabled && !isLogin;

  return (
    <>
      {isLogin ? null : <AmbientBackground />}
      <Navbar bottomNavEnabled={bottomNavEnabled} hubsEnabled={hubsEnabled} />
      <div
        className={
          showDock
            ? "relative z-10 flex flex-1 flex-col pb-20 md:pb-0"
            : "relative z-10 flex flex-1 flex-col"
        }
      >
        <main className="flex-1">
          <PageTransition>{children}</PageTransition>
        </main>
        {isLogin ? null : <Footer />}
      </div>
      {showDock ? <MobileDock hubsEnabled={hubsEnabled} /> : null}
    </>
  );
}
