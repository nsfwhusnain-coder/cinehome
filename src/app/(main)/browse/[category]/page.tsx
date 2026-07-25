import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BrowseCategoryView } from "@/views/browse-category";
import { resolveCategory } from "@/lib/browse-categories";

interface Props {
  params: Promise<{ category: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category: slug } = await params;
  const cat = resolveCategory(slug);
  if (!cat) {
    return { title: "Not Found" };
  }
  return { title: cat.title };
}

export default async function BrowseCategoryPage({ params }: Props) {
  const { category: slug } = await params;
  const cat = resolveCategory(slug);
  if (!cat) {
    notFound();
  }
  // Pass only serializable fields — never tmdbPathForPage (functions break RSC → client).
  return (
    <BrowseCategoryView
      slug={cat.slug}
      title={cat.title}
      mediaType={cat.mediaType}
      paged={cat.paged}
    />
  );
}
