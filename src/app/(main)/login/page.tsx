import { LoginView } from "@/views/login";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <LoginView callbackUrl={params.callbackUrl} error={params.error} />
  );
}
