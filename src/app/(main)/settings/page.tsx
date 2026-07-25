import type { Metadata } from "next";
import { SettingsView } from "@/views/settings";

export const metadata: Metadata = {
  title: "Settings",
  description: "Absolute Cinema account and server settings.",
};

export default function Page() {
  return <SettingsView />;
}
