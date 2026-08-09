import { readFile } from "node:fs/promises";
import path from "node:path";
import { api } from "@/lib/http";
import { UPLOAD_DIR, verifyFileUrl, mimeFromFileName } from "@/lib/upload";
import { forbidden } from "@/lib/errors";

export const GET = api(undefined, async (ctx) => {
  const fileName = path.basename(ctx.params.key);
  const expires = ctx.request.nextUrl.searchParams.get("expires") ?? "";
  const sig = ctx.request.nextUrl.searchParams.get("sig") ?? "";

  if (!verifyFileUrl(fileName, expires, sig)) {
    throw forbidden("INVALID_SIGNED_URL", "This link is invalid or has expired.");
  }

  try {
    const buf = await readFile(path.join(UPLOAD_DIR, fileName));
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": mimeFromFileName(fileName),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    throw forbidden("INVALID_SIGNED_URL", "File not found or link is invalid.");
  }
});
