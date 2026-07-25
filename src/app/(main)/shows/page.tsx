import type { Metadata } from "next";
import { BrowseHub } from "@/views/browse-hub";
import { showsHubRows } from "@/lib/browse-categories";

export const metadata: Metadata = {
  title: "Shows",
};

export default function ShowsPage() {
  return (
    <BrowseHub
      mediaType="tv"
      title="Shows"
      heroFrom="trending"
      rows={showsHubRows()}
    />
  );
}
