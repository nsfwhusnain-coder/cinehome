"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { KeyboardShortcutsHelp } from "@/components/keyboard-shortcuts-help";
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
