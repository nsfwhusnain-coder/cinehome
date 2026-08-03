"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRIMARY_NAV, isNavPathActive } from "@/lib/nav";
import { NavLettermark } from "@/components/brand-mark";
import { useSession } from "next-auth/react";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

/**
 * LordFlix-style clear glass pill — backdrop shows through;
 * ambient colors tint the material. Our nav items only (no bell).
 */
const NAV_PILL_GLASS: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  WebkitBackdropFilter: "blur(22px) saturate(180%) brightness(1.08)",
  backdropFilter: "blur(22px) saturate(180%) brightness(1.08)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -0.5px 0 rgba(255,255,255,0.08), 0 8px 28px rgba(0,0,0,0.28)",
};

interface NavbarProps {
  bottomNavEnabled?: boolean;
  hubsEnabled?: boolean;
}

/**
 * Two floating islands: logo lockup (left) + clear glass nav pill (right).
 * No full-bleed bar.
 */
export function Navbar({ bottomNavEnabled = true, hubsEnabled = true }: NavbarProps) {
  const pathname = usePathname();
  const { status: sessionStatus } = useSession();

  if (pathname.startsWith("/watch")) return null;

  // Every destination in this bar is behind auth, so rendering it to a
  // signed-out visitor offers six links that all redirect straight back to
  // sign-in. On a television it is worse than useless: the D-pad has to walk
  // past all of them before reaching the PIN field. Unauthenticated and
  // still-loading both hide it, so it cannot flash in during session probe.
  if (sessionStatus !== "authenticated") return null;

  const navItems = PRIMARY_NAV.filter(
    (item) => hubsEnabled || (item.path !== "/movies" && item.path !== "/shows")
  );

  return (
    <header
      className="pointer-events-none fixed inset-x-0 top-0 z-50 w-full"
      style={{ background: "none", backdropFilter: "none", WebkitBackdropFilter: "none" }}
    >
      <div className="relative z-10 mx-auto flex h-[72px] max-w-none items-center justify-between gap-4 pl-5 pr-5 sm:pl-6 sm:pr-7 lg:pr-8">
        {/* Island A — logo lockup */}
        <Link
          href="/"
          className={cn(
            "pointer-events-auto relative z-20 flex shrink-0 items-center rounded-lg",
            FOCUS_RING
          )}
          aria-label="Absolute Cinema home"
        >
          <NavLettermark />
        </Link>

        {/* Island B — clear glass pill (LordFlix look, our links/icons) */}
        <div
          className="pointer-events-auto relative flex h-12 shrink-0 items-center gap-0.5 rounded-full border border-white/20 p-1"
          style={NAV_PILL_GLASS}
        >
          {/* soft specular rim */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              padding: 1,
              background:
                "linear-gradient(160deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.08) 45%, rgba(255,255,255,0.18) 100%)",
              WebkitMask:
                "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
              WebkitMaskComposite: "xor",
              mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
              maskComposite: "exclude",
            }}
          />

          <nav
            className="relative z-[1] hidden items-center gap-0.5 md:flex"
            aria-label="Primary"
          >
            {navItems.map((item) => {
              const active = isNavPathActive(pathname, item.path);
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors duration-200",
                    FOCUS_RING,
                    active
                      ? "bg-white text-black shadow-sm"
                      : "text-white/85 hover:bg-white/10 hover:text-white"
                  )}
                >
                  {active && item.path === "/" ? (
                    <Home className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
                  ) : null}
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <span
            className="relative z-[1] mx-0.5 hidden h-4 w-px shrink-0 md:block"
            style={{ background: "rgba(255,255,255,0.2)" }}
            aria-hidden
          />

          <Link
            href="/search"
            className={cn(
              "relative z-[1] inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-200",
              FOCUS_RING,
              isNavPathActive(pathname, "/search")
                ? "bg-white text-black shadow-sm"
                : "text-white/85 hover:bg-white/10 hover:text-white",
              bottomNavEnabled && "max-md:hidden"
            )}
            aria-label="Search"
          >
            <Search className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          </Link>

          <Link
            href="/settings"
            className={cn(
              "relative z-[1] inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-200",
              FOCUS_RING,
              isNavPathActive(pathname, "/settings")
                ? "bg-white text-black shadow-sm"
                : "text-white/85 hover:bg-white/10 hover:text-white"
            )}
            aria-label="Settings"
          >
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          </Link>
        </div>
      </div>
    </header>
  );
}
