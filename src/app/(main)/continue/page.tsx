import type { Metadata } from "next";
import { ContinueWatchingView } from "@/views/continue-watching";

export const metadata: Metadata = {
  title: "Continue Watching",
  description: "Pick up where you left off on Absolute Cinema.",
};

export default function Page() {
  return <ContinueWatchingView />;
}
