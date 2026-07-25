import { TvSeasonView } from "@/views/tv-season";

export default async function Page({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  return <TvSeasonView tvId={Number(id)} season={Number(n)} />;
}
