/**
 * Isolated watch shell — full viewport, no main-layout navbar/container padding.
 * Side pillars must only come from object-fit:contain letterboxing, never layout.
 */
export default function WatchLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-[100] m-0 h-[100dvh] w-screen max-w-none overflow-hidden bg-black p-0"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        maxWidth: "none",
        margin: 0,
        padding: 0,
        background: "#000",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}
