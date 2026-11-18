import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";

// Confirmed live against the user's own instance (srx.plose.dev and a
// direct LAN IP:port): POST /api/upload, an `authorization` header holding
// the raw token (no "Bearer " prefix), and a multipart field named "file".
// Successful response shape per Zipline's docs: { files: [{ url }] }.
export function isConfigured() {
  return Boolean(process.env.ZIPLINE_URL && process.env.ZIPLINE_TOKEN);
}

const MIME_BY_EXT = { ".mp4": "video/mp4", ".mkv": "video/x-matroska" };

// Zipline v4 enables chunked uploads: any file larger than its server-side
// `chunksMax` setting (default ~95mb) MUST be uploaded through the partial
// (chunked) endpoint -- a single multipart POST of an oversized file is
// silently dropped and comes back as the misleading "E1062: No files in
// multipart" error (see CLAUDE.md's Zipline history). On top of that, the
// coordinator VM only has ~1.9GB RAM and the single-shot path reads the
// whole file into memory (twice, while building the body), so a large render
// (e.g. an 860MB 1440p144 replay) would OOM it even if the server accepted
// it. So: files over CHUNK_THRESHOLD are streamed to /api/upload/partial in
// CHUNK_SIZE pieces, keeping memory flat regardless of file size. Small files
// keep the proven single-shot path. Threshold is deliberately well under
// Zipline's default chunksMax; override via env if you lower chunksMax.
const CHUNK_SIZE = Number(process.env.ZIPLINE_CHUNK_SIZE_MB || 20) * 1024 * 1024;
const CHUNK_THRESHOLD = Number(process.env.ZIPLINE_CHUNK_THRESHOLD_MB || 60) * 1024 * 1024;

// Both node-fetch's and native fetch()'s FormData bodies get sent with
// Transfer-Encoding: chunked rather than a fixed Content-Length, since the
// Fetch spec doesn't require pre-computing length for stream-backed
// bodies. Zipline's multipart parser choked on that specifically (it
// worked fine over HTTPS through Cloudflare, which likely buffers/reframes
// the body, but failed direct-to-LAN with "no files in multipart" even
// though the body was well-formed) -- curl, which always buffers -F data
// and sends an explicit Content-Length, worked immediately against the
// same endpoint. So: build the multipart body ourselves as a plain
// buffer with an explicit Content-Length, matching exactly what curl does,
// instead of trusting fetch()'s automatic (and here, unreliable) encoding.
function buildMultipartBody(fieldName, bytes, filename, mimeType) {
  const boundary = `----osurr${crypto.randomBytes(16).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, bytes, tail]);
  return { boundary, body };
}

export async function uploadToZipline(filePath, filename) {
  const name = filename || path.basename(filePath);
  // No MIME type means multipart/form-data sends application/octet-stream
  // -- Zipline stores/serves the file with whatever content-type it
  // received, so an untyped upload comes back as a generic download
  // instead of an inline-playable video.
  const mimeType = MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";

  const size = fs.statSync(filePath).size;
  if (size > CHUNK_THRESHOLD) {
    return uploadChunkedToZipline(filePath, name, mimeType, size);
  }

  const bytes = fs.readFileSync(filePath);
  const { boundary, body } = buildMultipartBody("file", bytes, name, mimeType);

  const base = process.env.ZIPLINE_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: {
      authorization: process.env.ZIPLINE_TOKEN,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new Error(`Zipline upload failed: HTTP ${res.status} ${responseBody}`.trim());
  }

  const data = await res.json();
  const url = data.files?.[0]?.url;
  if (!url) throw new Error(`Zipline upload response had no file URL: ${JSON.stringify(data)}`);
  return toPublicUrl(url);
}

// Streams a large file to Zipline v4's chunked (partial) upload endpoint,
// replicating exactly what Zipline's own web client does
// (src/lib/client/upload/partial.tsx): POST each chunk to
// /api/upload/partial, sequentially, as a one-field ("file") multipart body,
// with the x-zipline-p-* headers and a `content-range` describing the chunk's
// byte span within the whole file. The final chunk (`lastchunk:true`) gets
// the completed file record in its response. Chunks are read from disk one
// at a time so peak memory stays at ~CHUNK_SIZE regardless of file size.
//
// PROTOCOL NOTE -- Zipline changed this endpoint in a later v4 release, and
// the old shape now fails on chunk 1 with "E1002: Invalid partial upload"
// (hit live right after the user updated their instance). Verified against
// Zipline trunk's server (src/server/routes/api/upload/partial.ts,
// src/lib/api/partial.ts) and its own web client:
//  - `content-range`'s end byte is now INCLUSIVE, standard HTTP semantics
//    (`bytes 0-20971519/N` for a 20MiB first chunk). The server checks
//    `end - start + 1 === <bytes received>` and `lastchunk === (end ===
//    total - 1)`. It used to be exclusive (`bytes 0-20971520/N`).
//  - Session continuity is now a single-use, per-chunk rotating token:
//    every non-final response returns `partialToken`, which must be sent
//    back as `x-zipline-p-token` on the NEXT chunk only (30 min expiry).
//    It used to be a fixed `partialIdentifier` echoed via
//    `x-zipline-p-identifier` on every chunk.
// If this breaks again after a Zipline update, diff those two server files
// first -- that is where both rules live.
async function uploadChunkedToZipline(filePath, name, mimeType, totalSize) {
  const base = process.env.ZIPLINE_URL.replace(/\/+$/, "");
  const nChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const fh = await fs.promises.open(filePath, "r");

  let token;
  let lastData;
  try {
    for (let j = 0; j < nChunks; j++) {
      const start = j * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize); // exclusive here; sent as inclusive (end - 1) below
      const len = end - start;
      const isLast = j === nChunks - 1;

      const chunk = Buffer.allocUnsafe(len);
      await fh.read(chunk, 0, len, start);

      // The chunk part's own filename/type don't matter -- Zipline takes the
      // real name and type from the x-zipline-p-* headers below (its web
      // client sends a bare Blob here). Keep it octet-stream to mirror that.
      const { boundary, body } = buildMultipartBody("file", chunk, "blob", "application/octet-stream");

      const headers = {
        authorization: process.env.ZIPLINE_TOKEN,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
        "x-zipline-p-filename": encodeURIComponent(name),
        "x-zipline-p-lastchunk": isLast ? "true" : "false",
        "x-zipline-p-content-type": mimeType,
        "x-zipline-p-content-length": String(totalSize),
        "content-range": `bytes ${start}-${end - 1}/${totalSize}`,
      };
      // The first chunk carries no token -- the server opens the session and
      // returns one; each later chunk must present the token from the chunk
      // immediately before it (single-use, rotates every chunk).
      if (token) headers["x-zipline-p-token"] = token;

      const res = await fetch(`${base}/api/upload/partial`, { method: "POST", headers, body });
      if (!res.ok) {
        const responseBody = await res.text().catch(() => "");
        throw new Error(
          `Zipline chunked upload failed on chunk ${j + 1}/${nChunks}: HTTP ${res.status} ${responseBody}`.trim(),
        );
      }

      const data = await res.json();
      if (!isLast) {
        token = data.partialToken;
        if (!token) {
          throw new Error(
            `Zipline partial upload gave no partialToken after chunk ${j + 1}/${nChunks} ` +
              `(server older than this client's chunk protocol?): ${JSON.stringify(data)}`,
          );
        }
      }
      lastData = data;
    }
  } finally {
    await fh.close();
  }

  const url = lastData?.files?.[0]?.url;
  if (!url) throw new Error(`Zipline chunked upload response had no file URL: ${JSON.stringify(lastData)}`);
  return toPublicUrl(url);
}

// Zipline builds the URL it returns from whatever host the upload request
// hit, not from a fixed public domain. That's normally fine, but ZIPLINE_URL
// sometimes has to be the LAN IP:port (bypassing Cloudflare's 100MB request
// cap, see CLAUDE.md) -- in that case Zipline hands back an
// https://<lan-ip>:3000/... link, which is unreachable off the LAN and has
// no valid TLS cert anyway. ZIPLINE_PUBLIC_URL lets the share link shown to
// users point at the real public domain regardless of which host the
// upload itself used. Falls back to ZIPLINE_URL when unset, which keeps
// existing single-URL setups working unchanged.
function toPublicUrl(rawUrl) {
  const publicBase = process.env.ZIPLINE_PUBLIC_URL || process.env.ZIPLINE_URL;
  try {
    const publicOrigin = new URL(publicBase);
    const url = new URL(rawUrl);
    url.protocol = publicOrigin.protocol;
    url.hostname = publicOrigin.hostname;
    // url.host would leave a stale port behind (e.g. the LAN ":3000")
    // instead of clearing it, since setting .host doesn't reset .port when
    // the new value omits one -- set .port explicitly instead.
    url.port = publicOrigin.port;
    return url.toString();
  } catch {
    return rawUrl;
  }
}
