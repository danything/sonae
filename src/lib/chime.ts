/**
 * 開いている画面で鳴らす短い音 (docs/design.md の 2.4)。音源のファイルは持たず、ここで WAV を組む
 * (自作。外の音源のライセンスを気にしなくてよい)。
 *
 * 高い音から低い音へ下がる 2 つの音 (880 Hz → 660 Hz)。それぞれ立ち上がりを短く、減衰を指数にして、
 * ぷつっと切れる音を出さない。モノラル・16 ビット・22.05 kHz で 0.7 秒ほど (約 30 KB)。
 */

const RATE = 22_050;

/** [周波数 (Hz), 始まり (秒), 長さ (秒)] */
const NOTES: readonly (readonly [number, number, number])[] = [
  [880, 0, 0.32],
  [660, 0.28, 0.42],
];

/** 音の波形 (-1〜1) を 16 ビットの PCM にした WAV を返す */
export function chimeWav(rate = RATE): Uint8Array<ArrayBuffer> {
  const seconds = Math.max(...NOTES.map(([, start, len]) => start + len));
  const n = Math.ceil(seconds * rate);
  const samples = new Float32Array(n);
  for (const [freq, start, len] of NOTES) {
    const from = Math.floor(start * rate);
    const count = Math.floor(len * rate);
    for (let i = 0; i < count && from + i < n; i++) {
      const t = i / rate;
      // 5 ミリ秒で立ち上げ、指数で減衰させ、最後の 20 ミリ秒で 0 へ落とす
      const attack = Math.min(1, t / 0.005);
      const release = Math.min(1, (len - t) / 0.02);
      const env = attack * release * Math.exp(-t * 6);
      // 倍音を少し足して、柔らかい鐘の音に近づける
      const wave =
        Math.sin(2 * Math.PI * freq * t) +
        0.25 * Math.sin(2 * Math.PI * freq * 2 * t);
      samples[from + i] = (samples[from + i] ?? 0) + 0.4 * env * wave;
    }
  }

  const data = n * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt の大きさ
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // モノラル
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // 1 秒のバイト数
  v.setUint16(32, 2, true); // 1 サンプルのバイト数
  v.setUint16(34, 16, true); // ビット数
  ascii(36, "data");
  v.setUint32(40, data, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, Math.round(s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}
