"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import dynamic from "next/dynamic";

/**
 * A dialog that only ever appears after someone presses "?". Loading its markup,
 * its Radix dialog dependency and its shortcut table in the initial bundle taxes
 * every route including the sign-in form, which measured 865 KB of JavaScript to
 * render two text fields. ssr:false because it renders nothing until opened.
 */
const KeyboardShortcutsHelp = dynamic(
  () =>
    import("@/components/keyboard-shortcuts-help").then(
      (m) => m.KeyboardShortcutsHelp
    ),
  { ssr: false }
);
import { ErrorBoundary } from "@/components/error-boundary";

function GlobalShortcuts() {
  const setShortcutsHelpOpen = useUIStore((s) => s.setShortcutsHelpOpen);
  useKeyboardShortcuts({ "?": () => setShortcutsHelpOpen(true) });
  return <KeyboardShortcutsHelp />;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  return (
    <SessionProvider>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <QueryClientProvider client={client}>
          {/* "user" — every motion component below respects prefers-reduced-motion
              automatically, no per-component useReducedMotion() checks needed. */}
          <MotionConfig reducedMotion="user">
            <ErrorBoundary>{children}</ErrorBoundary>
            <GlobalShortcuts />
          </MotionConfig>
        </QueryClientProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
