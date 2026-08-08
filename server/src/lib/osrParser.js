// Parser for the osu! replay (.osr) binary header.
// Format reference: osu! wiki "Client File Formats" -> osr (file format).
// We only need the header metadata (mode, beatmap hash, mods, player, score
// stats) to look up the matching beatmap and label the job -- danser-go
// reads and decodes the full file (including the LZMA-compressed input
// stream) itself, so we deliberately stop before that section.

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
