import type { Metadata } from "next";
import { WatchlistView } from "@/views/watchlist";

export const metadata: Metadata = {
  title: "My List",
  description: "Your saved movies and TV shows on Absolute Cinema.",
};

export default function Page() {
  return <WatchlistView />;
}
