import { BrandMark, BrandLockup, BrandWordmark } from "@/components/brand-mark";

export const metadata = {
  title: "Glass brand demo · Absolute Cinema",
  robots: { index: false, follow: false },
};

const POSTERS: { title: string; from: string; to: string }[] = [
  { title: "Neon Drift", from: "#ff2d55", to: "#5e17eb" },
  { title: "Azure Run", from: "#00c6ff", to: "#0072ff" },
  { title: "Gold Hour", from: "#f7971e", to: "#ffd200" },
  { title: "Forest", from: "#11998e", to: "#38ef7d" },
  { title: "Magenta", from: "#c33764", to: "#1d2671" },
  { title: "Coral", from: "#ff6a00", to: "#ee0979" },
  { title: "Ice", from: "#a1c4fd", to: "#c2e9fb" },
  { title: "Ember", from: "#eb3349", to: "#f45c43" },
  { title: "Violet", from: "#7f00ff", to: "#e100ff" },
  { title: "Lime", from: "#56ab2f", to: "#a8e063" },
  { title: "Royal", from: "#141e30", to: "#243b55" },
  { title: "Sunset", from: "#ff512f", to: "#dd2476" },
  { title: "Teal", from: "#136a8a", to: "#267871" },
  { title: "Candy", from: "#fc466b", to: "#3f5efb" },
  { title: "Steel", from: "#bdc3c7", to: "#2c3e50" },
  { title: "Aurora", from: "#00f5a0", to: "#00d9f5" },
];

function PosterCard({ title, from, to }: { title: string; from: string; to: string }) {
  return (
    <div
      className="relative h-[280px] w-[180px] shrink-0 overflow-hidden rounded-xl shadow-2xl sm:h-[340px] sm:w-[220px]"
      style={{ background: `linear-gradient(145deg, ${from}, ${to})` }}
    >
      <div
        className="absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.45), transparent 50%), radial-gradient(circle at 80% 80%, rgba(0,0,0,0.35), transparent 45%)",
        }}
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-10">
        <p className="text-sm font-semibold tracking-wide text-white/95">{title}</p>
      </div>
    </div>
  );
}

export default function BrandDemoPage() {
  const strip = [...POSTERS, ...POSTERS];

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <div className="fixed inset-0 overflow-hidden">
        <div className="ab-demo-strip flex h-full items-center gap-4 px-6 will-change-transform">
          {strip.map((p, i) => (
            <PosterCard key={`${p.title}-${i}`} {...p} />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-black/25" />
      </div>

      {/* Simulated nav lockup over scrolling posters */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex h-[72px] items-center pl-5 sm:pl-6">
        <div className="pointer-events-auto">
          <BrandLockup />
        </div>
      </div>

      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-10 px-6 py-24">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrandMark size="hero" />
          <BrandWordmark size="lg" />
          <p className="max-w-md text-sm text-white/70">
            Live CSS glass — <code className="text-white/90">backdrop-filter</code> blurs posters
            behind the tile. Nav lockup is fixed at top (56px + wordmark).
          </p>
        </div>

        <div className="flex flex-wrap items-end justify-center gap-8 rounded-3xl border border-white/10 bg-black/20 px-8 py-6">
          <div className="flex flex-col items-center gap-2">
            <BrandMark size="nav" />
            <span className="text-[11px] uppercase tracking-wider text-white/50">nav 56 compact</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <BrandMark size="lg" />
            <span className="text-[11px] uppercase tracking-wider text-white/50">lg 72 compact</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <BrandMark size="header" />
            <span className="text-[11px] uppercase tracking-wider text-white/50">header 140</span>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes ab-demo-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .ab-demo-strip {
          width: max-content;
          animation: ab-demo-scroll 48s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .ab-demo-strip { animation: none; }
        }
      `}</style>
    </div>
  );
}
