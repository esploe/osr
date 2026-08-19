// Parser for the osu! replay (.osr) binary header.
// Format reference: osu! wiki "Client File Formats" -> osr (file format).
// The header parser is enough for the render pipeline (it only needs mode,
// beatmap hash, mods, player). The frame parser (parseReplayFull) is used
// by the miss analyzer and walks the LZMA-compressed input stream that
// follows the header.

import lzma from "lzma";

const MODES = ["osu", "taiko", "fruits", "mania"];

const MOD_FLAGS = [
  ["NF", 1 << 0],
  ["EZ", 1 << 1],
  ["TD", 1 << 2],
  ["HD", 1 << 3],
  ["HR", 1 << 4],
  ["SD", 1 << 5],
  ["DT", 1 << 6],
  ["RX", 1 << 7],
  ["HT", 1 << 8],
  ["NC", 1 << 9],
  ["FL", 1 << 10],
  ["AT", 1 << 11],
  ["SO", 1 << 12],
  ["AP", 1 << 13],
  ["PF", 1 << 14],
  ["4K", 1 << 15],
  ["5K", 1 << 16],
  ["6K", 1 << 17],
  ["7K", 1 << 18],
  ["8K", 1 << 19],
  ["FI", 1 << 20],
  ["RD", 1 << 21],
  ["CN", 1 << 22],
  ["TP", 1 << 23],
  ["9K", 1 << 24],
  ["CO", 1 << 25],
  ["1K", 1 << 26],
  ["3K", 1 << 27],
  ["2K", 1 << 28],
  ["V2", 1 << 29],
  ["MR", 1 << 30],
];

export function modsToString(mods) {
  if (!mods) return "NM";
  const names = MOD_FLAGS.filter(([, bit]) => mods & bit).map(([name]) => name);
  return names.length ? names.join("") : "NM";
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  byte() {
    return this.buf.readUInt8(this.pos++);
  }
  bool() {
    return this.byte() !== 0;
  }
  int16() {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  int32() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  int64() {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  uleb128() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }
  // osu!'s "String" type: 0x00 = absent, 0x0b = ULEB128 length + UTF8 bytes
  string() {
    const marker = this.byte();
    if (marker === 0x00) return "";
    if (marker !== 0x0b) {
      throw new Error(`Unexpected string marker byte 0x${marker.toString(16)} at offset ${this.pos - 1}`);
    }
    const len = this.uleb128();
    const str = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return str;
  }
}

// Parses just the header fields, stopping right before the (LZMA-compressed)
// replay frame data, which we never need on the Node side.
export function parseReplayHeader(buffer) {
  const r = new Reader(buffer);

  const modeByte = r.byte();
  const gameVersion = r.int32();
  const beatmapHash = r.string();
  const playerName = r.string();
  const replayHash = r.string();
  const count300 = r.int16();
  const count100 = r.int16();
  const count50 = r.int16();
  const countGeki = r.int16();
  const countKatu = r.int16();
  const countMiss = r.int16();
  const totalScore = r.int32();
  const maxCombo = r.int16();
  const perfectCombo = r.bool();
  const mods = r.int32();
  const lifeBarGraph = r.string();
  const timestampTicks = r.int64(); // windows ticks (100ns since 0001-01-01), informational only

  return {
    mode: MODES[modeByte] ?? `unknown(${modeByte})`,
    modeByte,
    gameVersion,
    beatmapHash,
    playerName,
    replayHash,
    counts: { count300, count100, count50, countGeki, countKatu, countMiss },
    totalScore,
    maxCombo,
    perfectCombo,
    mods,
    modsString: modsToString(mods),
    lifeBarGraph,
    timestampTicks: timestampTicks.toString(),
    headerByteLength: r.pos,
  };
}

// Full parse: header + decompressed input frames. The compressed data
// starts right after the header at `int32 length` + that many bytes of
// LZMA1-alone stream. Each decoded frame is `w|x|y|z` (pipe-separated,
// comma-separated frames):
//   w = int64  ms elapsed since previous frame (or seed for the final
//                frame -- w = -12345 marks it and z is an RNG seed used by
//                the client, unrelated to gameplay; we drop it)
//   x = float  cursor X in osu! pixels (0-512, playfield-local)
//   y = float  cursor Y in osu! pixels (0-384)
//   z = int32  bitfield of pressed keys/buttons (see KEY_* below)
export const KEY_M1 = 1 << 0;
export const KEY_M2 = 1 << 1;
export const KEY_K1 = 1 << 2;
export const KEY_K2 = 1 << 3;
export const KEY_SMOKE = 1 << 4;
// K1 always also toggles M1 in modern clients (same for K2/M2), so we OR
// them together when checking for "was any hit-key just pressed?".
export const HIT_KEYS_MASK = KEY_M1 | KEY_M2 | KEY_K1 | KEY_K2;

export async function parseReplayFull(buffer) {
  const header = parseReplayHeader(buffer);
  let pos = header.headerByteLength;

  // A rare byte between lifeBarGraph and the frames section in some old
  // replays sets an int64 "online score id" -- modern clients place it
  // after the input data, but a few legacy ones inserted it here. We
  // detect the "modern" layout by checking that the next int32 is a
  // plausible compressed-data length (positive, fits inside the buffer).
  const declaredLen = buffer.readInt32LE(pos);
  if (declaredLen < 0 || pos + 4 + declaredLen > buffer.length) {
    throw new Error(`Compressed replay-data length looks wrong (${declaredLen}) -- old-format .osr with online-score-id in the header?`);
  }
  pos += 4;
  const compressed = buffer.subarray(pos, pos + declaredLen);

  const decoded = await new Promise((resolve, reject) => {
    // lzma-js accepts a Buffer-ish (typed array); result is an Array of
    // int8 values (signed bytes). Wrap it back into a Buffer for easy
    // slicing/toString below.
    lzma.decompress(compressed, (result, err) => {
      if (err) return reject(err);
      resolve(Buffer.from(result));
    });
  });

  const text = decoded.toString("utf8");
  const frames = [];
  let tAbs = 0;
  let seed = null;
  for (const chunk of text.split(",")) {
    if (!chunk) continue;
    const parts = chunk.split("|");
    if (parts.length !== 4) continue;
    const w = Number(parts[0]);
    const x = parseFloat(parts[1]);
    const y = parseFloat(parts[2]);
    const z = parseInt(parts[3], 10);
    if (w === -12345) {
      seed = z;
      continue;
    }
    tAbs += w;
    frames.push({ dt: w, t: tAbs, x, y, k: z });
  }

  return { ...header, frames, seed };
}
