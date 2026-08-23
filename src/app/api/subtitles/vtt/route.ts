import { NextRequest, NextResponse } from "next/server";
import { downloadAndConvertVtt } from "@/lib/subtitles/subtitles-service";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const downloadUrl = url.searchParams.get("url");

  if (!downloadUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  const vttText = await downloadAndConvertVtt(downloadUrl);
  if (!vttText) {
    return new NextResponse("WEBVTT\n\n", {
      status: 200,
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return new NextResponse(vttText, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
    },
  });
}
