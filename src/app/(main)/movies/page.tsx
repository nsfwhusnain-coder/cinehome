import type { Metadata } from "next";
import { BrowseHub } from "@/views/browse-hub";
import { movieHubRows } from "@/lib/browse-categories";

export const metadata: Metadata = {
  title: "Movies",
};

export default function MoviesPage() {
  return (
    <BrowseHub
      mediaType="movie"
      title="Movies"
      heroFrom="trending"
      rows={movieHubRows()}
    />
  );
}
