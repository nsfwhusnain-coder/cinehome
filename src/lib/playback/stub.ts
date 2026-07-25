import type { PlaybackProvider } from "./types";

export const StubPlaybackProvider: PlaybackProvider = {
  id: "stub",
  name: "Not configured",
  async resolve() {
    return {
      status: "not_configured",
      message: "No playback provider is configured yet. The admin can set one up in Settings.",
      action: {
        label: "Go to Settings",
        requestEndpoint: "/settings",
      },
    };
  },
};
