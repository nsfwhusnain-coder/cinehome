export const metadata = {
  title: "DMCA",
  description: "DMCA notice for Absolute Cinema",
};

export default function DmcaPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 pb-20 pt-28">
      <h1 className="font-display text-3xl font-bold tracking-tight">DMCA Notice</h1>
      <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          Absolute Cinema is a personal, self-hosted interface for discovering and playing media
          streams sourced from third-party providers. Absolute Cinema does not host, store, upload,
          or distribute any copyrighted media files on its servers.
        </p>
        <p>
          All stream links are resolved dynamically from external sources at playback time.
          If you believe content accessible through a third-party provider infringes your
          copyright, please contact that provider directly. Absolute Cinema cannot remove content
          that it does not host.
        </p>
        <p>
          For questions about this notice, contact the site operator through your local
          admin channel.
        </p>
      </div>
    </div>
  );
}
