import type { Metadata } from "next";
import { HomeView } from "@/views/home";

export const metadata: Metadata = {
  title: "Home",
  description: "Browse trending movies and TV shows on Absolute Cinema.",
};

export default function Page() {
  return <HomeView />;
}
