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
  const bytes = fs.readFileSync(filePath);
  const name = filename || path.basename(filePath);
  // No MIME type means multipart/form-data sends application/octet-stream
  // -- Zipline stores/serves the file with whatever content-type it
  // received, so an untyped upload comes back as a generic download
  // instead of an inline-playable video.
  const mimeType = MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";
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
  return url;
}
