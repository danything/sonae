/**
 * zip を読む小さな道具 (地図の区域を作る tools/areas/ だけで使う)。コンテナの bun の slim には
 * unzip が無いので、中央ディレクトリを読み、node:zlib で戻す。名前は Shift_JIS のことがあるので
 * 生のバイトのまま返す (使う側は拡張子だけを見る)。
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** 名前 (区切りは / か \)。Shift_JIS の zip でも latin1 で読んだ字のまま */
  name: string;
  data(): Buffer;
}

export function readZip(buf: Buffer): ZipEntry[] {
  // 中央ディレクトリの終わり (EOCD) を後ろから探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("zip の終わりが見つかりません");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("zip の中央ディレクトリが読めません");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.push({
      name,
      data() {
        const start =
          local +
          30 +
          buf.readUInt16LE(local + 26) +
          buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`zip の圧縮の形 ${method} は読めません`);
      },
    });
  }
  return out;
}

/** `bun tools/areas/zip.ts <zip> <出す所> <名前>`: シェープファイルを `<名前>.<拡張子>` で出す */
if (import.meta.main) {
  const [zip, dir, base] = process.argv.slice(2);
  if (!zip || !dir || !base)
    throw new Error("zip と出す所と名前を渡してください");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  for (const e of readZip(readFileSync(zip))) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(e.name)?.[1]?.toLowerCase();
    if (!ext || e.name.endsWith("/")) continue;
    writeFileSync(`${dir}/${base}.${ext}`, e.data());
  }
}
