"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useUIStore } from "@/stores/ui-store";

export function PWARegister() {
  const setInstallPrompt = useUIStore((s) => s.setInstallPrompt);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Bump cache / strategy: force check for updated sw.js after deploy.
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        // Proactively look for updates on load
        registration.update().catch(() => {});

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              toast("Update available", {
                description: "A new version of Absolute Cinema is ready.",
                action: {
                  label: "Reload",
                  onClick: () => {
                    installing.postMessage({ type: "SKIP_WAITING" });
                    window.location.reload();
                  },
                },
              });
            }
          });
        });
      })
      .catch(() => {
        // Service worker registration failed — app still works without offline caching.
      });
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    // Fires once the user accepts the prompt (from our UI or the OS chrome) —
    // the deferred event is now spent, so clear it and hide the install affordance.
    const onAppInstalled = () => {
      setInstallPrompt(null);
      toast.success("Absolute Cinema installed");
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [setInstallPrompt]);

  // Keep-alive every 5 minutes so idle hosts don't cold-sleep the app process.
  useEffect(() => {
    const ping = () => {
      void fetch("/api/system-status", { method: "GET", cache: "no-store" }).catch(() => {});
    };
    ping();
    const id = window.setInterval(ping, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  return null;
}

/** Minimal typing for the deferred install event (not in all TS lib versions). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}
