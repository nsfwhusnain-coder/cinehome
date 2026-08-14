import { MainChrome } from "./main-chrome";
import { isBottomNavEnabled, isHubsEnabled } from "@/lib/feature-flags";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const [bottomNavEnabled, hubsEnabled] = await Promise.all([
    isBottomNavEnabled(),
    isHubsEnabled(),
  ]);

  return (
    <div className="relative min-h-screen flex flex-col text-foreground">
      <MainChrome bottomNavEnabled={bottomNavEnabled} hubsEnabled={hubsEnabled}>
        {children}
      </MainChrome>
    </div>
  );
}
