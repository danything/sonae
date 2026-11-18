/**
 * VOICEVOX のエンジン (別のコンテナ) で読み上げの音を作る (docs/design.md の 2.4)。
 *
 * - 声はこの家で 1 つ (サーバーの DB に持つ。`settings.ts`)。選んでいなければ既定の声 (剣崎雌雄、`DEFAULT_SPEAKER`)。
 * - 事象を受けたら、読み上げの原稿 (`#lib/readout.ts`) の変わる文を、選んである声 1 つで合成して持つ。
 *   画面は原稿を自分で作り、文ごとに `POST /api/speech` で音を取りに来る。
 * - 冒頭の決まった文は、起動したとき・つながり直したとき・声を替えたときに、選んである声で合成しておく。
 * - 合成した音はメモリに (声, 文) の組で持つ。選んである声の決まった文は捨てず、ほかは古いものから上限まで捨てる。
 * - 合成は 1 つずつ順に頼む (エンジンは CPU で 1 つずつ合成する)。事象の文を、声の下ごしらえより先にする。
 * - 地名の読みはユーザー辞書 (`readings.ts`) で直す。エンジンは辞書をコンテナの中に持つので、
 *   つながるたびに足りない語を足す。
 * - 合成できる文は、決まった文と、受けた事象の原稿の文だけ (勝手な文をエンジンに読ませない)。
 */

import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { SonaeEvent } from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import {
  FIXED_TEXTS,
  isFixed,
  readoutCandidates,
  readoutOf,
} from "#lib/readout.ts";
import {
  ALLOWED_SPEAKERS,
  DEFAULT_SPEAKER,
  type SpeechInfo,
  type Voice,
} from "#lib/voices.ts";

import { type Reading, READINGS } from "./readings.ts";
import { voiceStore } from "./settings.ts";

/** 選んである声の置き場 (DB の `settings`。`settings.ts`) */
export interface VoiceStore {
  load(): number | undefined;
  /** `by` は替えた人 (IdP の sub) */
  save(id: number, by: string): void;
}

export interface VoicevoxOptions {
  /** エンジンの URL (`http://voicevox:50021`) */
  url: string;
  fetch?: typeof fetch;
  /** 選んである声の置き場。無ければメモリにだけ持つ (テスト) */
  store?: VoiceStore;
  now?: () => number;
  /** 音を持つ上限 (バイト)。選んである声の決まった文は数えるが捨てない */
  maxBytes?: number;
}

/** 合成を待つ上限。CPU の合成は長い文で数秒かかる */
const SYNTH_TIMEOUT_MS = 30_000;
/** つながりを確かめる間隔 */
const CHECK_MS = 60_000;
/**
 * 合成してよい文 (受けた事象の原稿) を覚える数。気象警報・注意報は 1 通で府県予報区の市町村等ごとの文
 * (多い府県で 2 百ほど、特別警報なら倍) を通すので、大雨の続く間に地震の文を押し出さないよう多めにする
 * (文字列を覚えるだけで、合成はしない)
 */
const ALLOWED_TEXTS_MAX = 20_000;

interface Job {
  key: string;
  run: () => Promise<void>;
}

const keyOf = (speaker: number, text: string) => `${speaker}\n${text}`;
const speakerOfKey = (key: string) => Number(key.slice(0, key.indexOf("\n")));
const textOfKey = (key: string) => key.slice(key.indexOf("\n") + 1);

export class Voicevox {
  readonly url: string;
  readonly defaultSpeaker: number;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly voiceStore: VoiceStore | undefined;
  /** 選んである声 (覚えた値のまま。選べるかは `speaker` で見る) */
  private chosen: number | undefined;
  private readonly voiceListeners = new Set<(id: number) => void>();

  available = false;
  voices: Voice[] = [];

  private readonly cache = new Map<string, Uint8Array<ArrayBuffer>>();
  /** 辞書を直すたびに 1 つ進める。前の世代で合成を始めた音は持たない */
  private generation = 0;
  private bytes = 0;
  private readonly pending = new Map<
    string,
    Promise<Uint8Array<ArrayBuffer>>
  >();
  private readonly urgent: Job[] = [];
  private readonly background: Job[] = [];
  private working = false;
  /** いま走っている `check` (重ねて走らせない) */
  private checking: Promise<boolean> | undefined;
  private readonly allowed = new Set<string>(FIXED_TEXTS);

  constructor(o: VoicevoxOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.defaultSpeaker = DEFAULT_SPEAKER;
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
    this.voiceStore = o.store;
    try {
      this.chosen = o.store?.load();
    } catch (err) {
      console.warn(`[voicevox] 選んである声を読めませんでした: ${err}`);
    }
  }

  /**
   * いま読む声。選んである声がエンジンの選べる声に無ければ (つながる前・エンジンを替えて無くなった・
   * 規約で外した) 既定の声
   */
  get speaker(): number {
    const c = this.chosen;
    return c !== undefined && this.voices.some((v) => v.id === c)
      ? c
      : this.defaultSpeaker;
  }

  /** 画面に渡す情報 */
  info(): SpeechInfo {
    return {
      available: this.available,
      defaultSpeaker: this.defaultSpeaker,
      voice: this.speaker,
      voices: this.voices,
    };
  }

  /** 読む声が替わったら呼ぶ (開いている画面へ SSE で知らせる)。やめる関数を返す */
  onVoice(fn: (id: number) => void): () => void {
    this.voiceListeners.add(fn);
    return () => this.voiceListeners.delete(fn);
  }

  /**
   * この家の声を替える (`PUT /api/speech`)。選べない声なら false。替えたら覚え、新しい声で
   * 決まった文をすぐ合成し直し、開いている画面に知らせる
   */
  setVoice(id: number, by: string): boolean {
    if (!this.isVoice(id)) return false;
    const before = this.speaker;
    this.voiceStore?.save(id, by);
    this.chosen = id;
    if (this.speaker !== before) this.voiceChanged();
    return true;
  }

  private voiceChanged(): void {
    const s = this.speaker;
    console.log(`[voicevox] 読む声を ${s} にしました`);
    if (this.available) this.warm(s);
    for (const fn of this.voiceListeners) {
      try {
        fn(s);
      } catch (err) {
        console.warn(`[voicevox] 声の知らせを配れませんでした: ${err}`);
      }
    }
  }

  /** 選べる声か (つながる前は既定の声だけ) */
  isVoice(id: number): boolean {
    return id === this.defaultSpeaker || this.voices.some((v) => v.id === id);
  }

  isAllowed(text: string): boolean {
    return this.allowed.has(text);
  }

  isCached(speaker: number, text: string): boolean {
    return this.cache.has(keyOf(speaker, text));
  }

  /** 決まった文をこの声で合成しておく (後回しの列に入れる) */
  warm(speaker: number): void {
    for (const t of FIXED_TEXTS)
      void this.audio(speaker, t, false).catch(() => {});
  }

  /** 受けた事象の原稿を、選んである声 1 つで合成しておく */
  handle(e: SonaeEvent): void {
    const n = noticeOf(e, this.now());
    if (!n) return;
    const parts = readoutOf(n);
    // 気象警報・注意報は住んでいる地域で文が変わるので、市町村等ごとの文も通す (合成は取りに来たときだけ)
    for (const p of readoutCandidates(n)) this.allow(p);
    if (!this.available) return;
    const speaker = this.speaker;
    for (const p of parts)
      if (!isFixed(p)) void this.audio(speaker, p, true).catch(() => {});
  }

  private allow(text: string): void {
    if (this.allowed.has(text)) return;
    this.allowed.add(text);
    if (this.allowed.size > ALLOWED_TEXTS_MAX + FIXED_TEXTS.length) {
      for (const t of this.allowed) {
        if (isFixed(t)) continue;
        this.allowed.delete(t);
        break;
      }
    }
  }

  /**
   * 音 (WAV) を返す。持っていればすぐ、合成中ならそれを待ち、無ければ列に入れる。
   * `urgent` は事象の文と、画面が待っている文。下ごしらえより先に合成する
   */
  audio(
    speaker: number,
    text: string,
    urgent = true,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const key = keyOf(speaker, text);
    const hit = this.cache.get(key);
    if (hit) {
      // 新しく使ったものを後ろへ (古いものから捨てる)
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const running = this.pending.get(key);
    if (running) {
      if (urgent) this.promote(key);
      return running;
    }
    const p = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const job: Job = {
        key,
        run: () => {
          // 合成の途中で辞書が変わったら、その音は持たない (古い読みのことがある)
          const generation = this.generation;
          return this.synthesize(speaker, text).then((wav) => {
            if (generation === this.generation) this.store(key, wav);
            resolve(wav);
          }, reject);
        },
      };
      (urgent ? this.urgent : this.background).push(job);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    void this.pump();
    return p;
  }

  private promote(key: string): void {
    const i = this.background.findIndex((j) => j.key === key);
    if (i < 0) return;
    const [job] = this.background.splice(i, 1);
    if (job) this.urgent.push(job);
  }

  private async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.urgent.shift() ?? this.background.shift();
        if (!job) break;
        await job.run().catch(() => {});
      }
    } finally {
      this.working = false;
    }
  }

  private store(key: string, wav: Uint8Array<ArrayBuffer>): void {
    this.cache.set(key, wav);
    this.bytes += wav.byteLength;
    // 選んである声の決まった文は捨てない。前の声の決まった文は、ほかと同じく古いものから捨てる
    const keep = this.speaker;
    for (const [k, v] of this.cache) {
      if (this.bytes <= this.maxBytes) break;
      if (k === key || (speakerOfKey(k) === keep && isFixed(textOfKey(k))))
        continue;
      this.cache.delete(k);
      this.bytes -= v.byteLength;
    }
  }

  private async call(
    path: string,
    init: RequestInit = {},
    timeout = SYNTH_TIMEOUT_MS,
  ): Promise<Response> {
    const res = await this.f(`${this.url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok)
      throw new Error(`VOICEVOX ${path.split("?")[0]} ${res.status}`);
    return res;
  }

  /**
   * audio_query で読みと抑揚を作り、synthesis で WAV にする。かかった秒数と音の秒数を 1 行で出す
   * (話している間に次の文が間に合うかを見るため。文の中身は出さず、字数だけ)
   */
  async synthesize(
    speaker: number,
    text: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const started = performance.now();
    const wav = await this.synthesizeOnce(speaker, text);
    const took = (performance.now() - started) / 1000;
    const sound = wavSeconds(wav);
    console.log(
      `[voicevox] 合成 ${isFixed(text) ? "決まった文" : "事象の文"} ${text.length} 字 声 ${speaker}: ` +
        `${took.toFixed(2)} 秒 / 音 ${sound === undefined ? "?" : sound.toFixed(2)} 秒`,
    );
    return wav;
  }

  private async synthesizeOnce(
    speaker: number,
    text: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const q = new URLSearchParams({ speaker: String(speaker), text });
    const query = await (
      await this.call(`/audio_query?${q}`, { method: "POST" })
    ).json();
    const res = await this.call(`/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * 選べる声を `/speakers` から作る (規約を確かめたキャラクターだけ。既定の声の剣崎雌雄も入っている)
   */
  async loadVoices(): Promise<void> {
    const list = (await (await this.call("/speakers", {}, 10_000)).json()) as {
      name: string;
      speaker_uuid: string;
      styles: { name: string; id: number; type?: string }[];
    }[];
    this.voices = list.flatMap((s) =>
      s.styles
        .filter(
          (st) =>
            (st.type ?? "talk").endsWith("talk") &&
            ALLOWED_SPEAKERS.has(s.speaker_uuid),
        )
        .map((st) => ({ id: st.id, name: s.name, style: st.name })),
    );
  }

  /** ユーザー辞書に足りない読みを足す (読みの違う語は直す) */
  async syncDictionary(
    readings: readonly Reading[] = READINGS,
  ): Promise<number> {
    const dict = (await (
      await this.call("/user_dict", {}, 10_000)
    ).json()) as Record<
      string,
      { surface: string; pronunciation: string; accent_type: number }
    >;
    // エンジンは表記を全角にして持つ。地名は全角なので、そのまま比べる
    const bySurface = new Map(
      Object.entries(dict).map(([id, w]) => [w.surface, { id, ...w }]),
    );
    let changed = 0;
    for (const r of readings) {
      const have = bySurface.get(r.surface);
      if (
        have &&
        have.pronunciation === r.pronunciation &&
        have.accent_type === r.accent
      )
        continue;
      const q = new URLSearchParams({
        surface: r.surface,
        pronunciation: r.pronunciation,
        accent_type: String(r.accent),
        word_type: "PROPER_NOUN",
        priority: "10",
      });
      await this.call(
        have ? `/user_dict_word/${have.id}?${q}` : `/user_dict_word?${q}`,
        { method: have ? "PUT" : "POST" },
        10_000,
      );
      changed++;
    }
    return changed;
  }

  /**
   * つながりを確かめる。つながり直したら、声の一覧と辞書を読み直し、決まった文を下ごしらえする。
   * 辞書を直したら、それまでに合成した音は読みが違うことがあるので捨てる。
   * 前の確かめが終わっていなければ (エンジンが遅く、1 分ごとの次の回が重なったとき)、それを待つ。
   * 重ねて走らせると、どちらも同じ辞書を読んでから足すので、同じ語が二重に入る
   */
  check(): Promise<boolean> {
    this.checking ??= this.checkOnce().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async checkOnce(): Promise<boolean> {
    try {
      await this.call("/version", {}, 5_000);
      const was = this.available;
      const before = this.speaker;
      await this.loadVoices();
      const changed = await this.syncDictionary();
      if (changed > 0) this.clear();
      this.available = true;
      const speaker = this.speaker;
      if (!was || changed > 0) {
        console.log(
          `[voicevox] つながりました (選べる声 ${this.voices.length}、辞書に足した語 ${changed}、読む声 ${speaker})`,
        );
        this.warm(speaker);
      }
      // 声の一覧を読んで、選んである声が読めるようになった (または無くなった)
      if (speaker !== before) this.voiceChanged();
      return true;
    } catch (err) {
      if (this.available) console.warn(`[voicevox] つながりません: ${err}`);
      this.available = false;
      return false;
    }
  }

  private clear(): void {
    this.generation++;
    this.cache.clear();
    this.bytes = 0;
  }

  /** つながりを定期に確かめる。止める関数を返す */
  start(): () => void {
    void this.check().then((ok) => {
      if (!ok)
        console.warn(
          `[voicevox] ${this.url} につながりません。つながるまで、画面は端末の読み上げで読みます`,
        );
    });
    const timer = setInterval(() => void this.check(), CHECK_MS);
    return () => clearInterval(timer);
  }
}

/**
 * WAV の音の秒数 (`data` の大きさ ÷ fmt の 1 秒あたりのバイト数)。WAV として読めなければ undefined
 */
export function wavSeconds(wav: Uint8Array): number | undefined {
  if (wav.byteLength < 12) return undefined;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let byteRate = 0;
  for (let at = 12; at + 8 <= wav.byteLength;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && at + 20 <= wav.byteLength)
      byteRate = view.getUint32(at + 16, true);
    if (tag(at) === "data")
      return byteRate > 0
        ? Math.min(size, wav.byteLength - at - 8) / byteRate
        : undefined;
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/**
 * 環境変数から作る。`VOICEVOX_URL` が空なら作らない (画面は端末の読み上げで読む)。
 * 選んである声は DB (`d`) に持つ。まだ選んでいないときは剣崎雌雄 (`DEFAULT_SPEAKER`)。
 * 前の `VOICEVOX_SPEAKER` は読まない (声は画面で選ぶ。持ち主の決定、2026-11-16)
 */
export function voicevoxFromEnv(d: Database): Voicevox | undefined {
  const url = process.env.VOICEVOX_URL?.trim();
  if (!url) return undefined;
  // 前は端末ごとの声を「使われている声」としてファイルに覚えていた。もう読まないので消す
  try {
    rmSync(join(process.env.SONAE_DATA || "./data", "voices.json"), {
      force: true,
    });
  } catch {
    // 消せなくても読まないだけ
  }
  return new Voicevox({ url, store: voiceStore(d) });
}

/**
 * 1 つの文の音を、選んである声で返す (`POST /api/speech`。本文は `{ text }`)。
 * - 合成してよい文 (決まった文と、受けた事象の原稿) でなければ 404。
 * - 受けたときと声を替えたときに合成を始めているので、たいていは済んでいる。まだなら合成を待つ。
 *   どの声かは `x-voice` で返す。
 */
export async function serveSpeech(
  v: Voicevox,
  text: string,
): Promise<Response> {
  if (!v.isAllowed(text))
    return new Response("この文は読み上げられません", { status: 404 });
  if (!v.available)
    return new Response("VOICEVOX につながりません", { status: 503 });
  const speaker = v.speaker;
  try {
    const wav = await v.audio(speaker, text, true);
    return new Response(wav, {
      headers: {
        "content-type": "audio/wav",
        "cache-control": "private, no-store",
        "x-voice": String(speaker),
      },
    });
  } catch (err) {
    return new Response(`合成できませんでした: ${err}`, { status: 502 });
  }
}

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * この家の声を替える (`PUT /api/speech`。本文は `{ voice }`)。替えたら選べる声と読む声 (`SpeechInfo`) を返す。
 * - ログインした人なら誰でも替えられる (通すロールは 1 つで、ログインした人はみな同じロールを持つ。2.6)。
 *   `subject` が無ければ 401 (hooks の内側なので、ふつうは来ない)。
 * - 本文は JSON だけ受ける (415)。ほかのサイトから JSON で送るにはプリフライトが要り、通らない
 *   (フォームの形は SvelteKit が別のオリジンから受けない)。
 * - VOICEVOX を使っていなければ 404、選べない声は 400。
 */
export async function changeVoice(
  v: Voicevox | undefined,
  subject: string | undefined,
  request: Request,
): Promise<Response> {
  if (!subject) return plain(401, "login required");
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json"))
    return plain(415, "JSON の本文が要ります");
  if (!v) return plain(404, "VOICEVOX は使っていません");
  let id: unknown;
  try {
    id = ((await request.json()) as { voice?: unknown } | null)?.voice;
  } catch {
    return plain(400, "JSON の本文が要ります");
  }
  if (typeof id !== "number" || !Number.isInteger(id))
    return plain(400, "voice が要ります");
  if (!v.setVoice(id, subject)) return plain(400, "選べない声です");
  return Response.json(v.info());
}
