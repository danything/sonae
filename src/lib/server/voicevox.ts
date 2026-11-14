/**
 * VOICEVOX のエンジン (別のコンテナ) で読み上げの音を作る (docs/design.md の 2.4)。
 *
 * - 事象を受けたら、読み上げの原稿 (`#lib/readout.ts`) の変わる文を、使われている声ごとに合成して持つ。
 *   画面は原稿を自分で作り、文ごとに `POST /api/speech` で音を取りに来る。
 * - 冒頭の決まった文は、起動したときと、つながり直したときに合成しておく (既定の声と、使われている声)。
 * - 合成した音はメモリに (声, 文) の組で持つ。決まった文は捨てず、ほかは古いものから上限まで捨てる。
 * - 合成は 1 つずつ順に頼む (エンジンは CPU で 1 つずつ合成する)。事象の文を、声の下ごしらえより先にする。
 * - 地名の読みはユーザー辞書 (`readings.ts`) で直す。エンジンは辞書をコンテナの中に持つので、
 *   つながるたびに足りない語を足す。
 * - 合成できる文は、決まった文と、受けた事象の原稿の文だけ (勝手な文をエンジンに読ませない)。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SonaeEvent } from "#lib/model.ts";
import { noticeOf } from "#lib/notify.ts";
import { FIXED_TEXTS, isFixed, readoutOf, SAMPLE } from "#lib/readout.ts";
import {
  ALLOWED_SPEAKERS,
  DEFAULT_SPEAKER,
  type SpeechInfo,
  type Voice,
} from "#lib/voices.ts";

import { type Reading, READINGS } from "./readings.ts";

export interface VoicevoxOptions {
  /** エンジンの URL (`http://voicevox:50021`) */
  url: string;
  defaultSpeaker?: number;
  fetch?: typeof fetch;
  /** 使われている声を覚えるファイルを置く所。無ければ覚えない (テスト) */
  dataDir?: string;
  now?: () => number;
  /** 音を持つ上限 (バイト)。決まった文は数えるが捨てない */
  maxBytes?: number;
}

/** 合成を待つ上限。CPU の合成は長い文で数秒かかる */
const SYNTH_TIMEOUT_MS = 30_000;
/** つながりを確かめる間隔 */
const CHECK_MS = 60_000;
/** 使われなくなった声を下ごしらえから外すまで */
const VOICE_TTL_MS = 30 * 24 * 60 * 60_000;
/**
 * 前もって合成する声の数 (既定の声のほか)。声ごとにエンジンがモデルを読み、メモリを 0.5 GB ほど使う
 */
const VOICES_MAX = 3;
/** 合成してよい文 (受けた事象の原稿) を覚える数 */
const ALLOWED_TEXTS_MAX = 2000;

interface Job {
  key: string;
  run: () => Promise<void>;
}

const keyOf = (speaker: number, text: string) => `${speaker}\n${text}`;

export class Voicevox {
  readonly url: string;
  readonly defaultSpeaker: number;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly file: string | undefined;

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
  private readonly allowed = new Set<string>(FIXED_TEXTS);
  /** 使われている声 (スタイルの id → 最後に使われた時刻) */
  private readonly inUse = new Map<number, number>();

  constructor(o: VoicevoxOptions) {
    this.url = o.url.replace(/\/+$/, "");
    this.defaultSpeaker = o.defaultSpeaker ?? DEFAULT_SPEAKER;
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
    this.file = o.dataDir ? join(o.dataDir, "voices.json") : undefined;
    this.loadInUse();
  }

  /** 画面に渡す情報 */
  info(): SpeechInfo {
    return {
      available: this.available,
      defaultSpeaker: this.defaultSpeaker,
      voices: this.voices,
    };
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

  /** 使われている声。既定の声を先に、ほかは新しく使われた順 */
  voicesInUse(): number[] {
    const t = this.now();
    const others = [...this.inUse]
      .filter(([id, at]) => id !== this.defaultSpeaker && t - at < VOICE_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .slice(0, VOICES_MAX);
    return [this.defaultSpeaker, ...others];
  }

  /** この声で読める (既定の声か、使われている声に入っている) */
  isActive(speaker: number): boolean {
    return this.voicesInUse().includes(speaker);
  }

  /**
   * 端末が声を選んだ (または、選んだ声で音を取りに来た)。覚えて、決まった文を下ごしらえする。
   * 使われている声が既定の声のほかに `VOICES_MAX` あるときは、新しい声を足さない
   * (エンジンは読んだモデルを手放さないので、声の数でメモリが増え続けないように)
   */
  use(speaker: number): void {
    if (!this.isVoice(speaker)) return;
    if (
      speaker !== this.defaultSpeaker &&
      !this.isActive(speaker) &&
      this.voicesInUse().length > VOICES_MAX
    )
      return;
    const first = !this.inUse.has(speaker);
    const prev = this.inUse.get(speaker) ?? 0;
    this.inUse.set(speaker, this.now());
    // 書き込みは日に 1 回ほどで足りる
    if (first || this.now() - prev > 60 * 60_000) this.saveInUse();
    if (this.available) this.warm(speaker);
  }

  /** 決まった文をこの声で合成しておく (後回しの列に入れる) */
  warm(speaker: number): void {
    for (const t of FIXED_TEXTS)
      void this.audio(speaker, t, false).catch(() => {});
  }

  /** 受けた事象の原稿を、使われている声ごとに合成しておく */
  handle(e: SonaeEvent): void {
    const n = noticeOf(e, this.now());
    if (!n) return;
    const parts = readoutOf(n);
    for (const p of parts) this.allow(p);
    if (!this.available) return;
    for (const speaker of this.voicesInUse())
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
    for (const [k, v] of this.cache) {
      if (this.bytes <= this.maxBytes) break;
      if (k === key || isFixed(k.slice(k.indexOf("\n") + 1))) continue;
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

  /** audio_query で読みと抑揚を作り、synthesis で WAV にする */
  async synthesize(
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
   * 選べる声を `/speakers` から作る (規約を確かめたキャラクターだけ)。既定の声は、運用する人が
   * `VOICEVOX_SPEAKER` で選んだものなので、一覧に無くても入れる (クレジットの名前に要る)
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
            (ALLOWED_SPEAKERS.has(s.speaker_uuid) ||
              st.id === this.defaultSpeaker),
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
   * 辞書を直したら、それまでに合成した音は読みが違うことがあるので捨てる
   */
  async check(): Promise<boolean> {
    try {
      await this.call("/version", {}, 5_000);
      const was = this.available;
      await this.loadVoices();
      const changed = await this.syncDictionary();
      if (changed > 0) this.clear();
      this.available = true;
      if (!was || changed > 0) {
        console.log(
          `[voicevox] つながりました (選べる声 ${this.voices.length}、辞書に足した語 ${changed})`,
        );
        for (const s of this.voicesInUse()) this.warm(s);
      }
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

  private loadInUse(): void {
    if (!this.file) return;
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8")) as Record<
        string,
        number
      >;
      for (const [id, at] of Object.entries(o))
        if (Number.isInteger(Number(id)) && typeof at === "number")
          this.inUse.set(Number(id), at);
    } catch {
      // 初めて、または読めない (覚えていないだけ)
    }
  }

  private saveInUse(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.inUse)));
    } catch (err) {
      console.warn(`[voicevox] 使われている声を覚えられませんでした: ${err}`);
    }
  }
}

/** 環境変数から作る。`VOICEVOX_URL` が空なら作らない (画面は端末の読み上げで読む) */
export function voicevoxFromEnv(): Voicevox | undefined {
  const url = process.env.VOICEVOX_URL?.trim();
  if (!url) return undefined;
  const raw = process.env.VOICEVOX_SPEAKER?.trim();
  const sp = raw ? Number(raw) : Number.NaN;
  return new Voicevox({
    url,
    defaultSpeaker: Number.isInteger(sp) && sp >= 0 ? sp : DEFAULT_SPEAKER,
    dataDir: process.env.SONAE_DATA || "./data",
  });
}

/** `POST /api/speech` の本文 */
export interface SpeechRequest {
  text: string;
  /** 端末が選んだ声 (無ければ既定の声) */
  voice?: number;
}

/**
 * 1 つの文の音を返す (`POST /api/speech`)。
 * - 合成してよい文 (決まった文と、受けた事象の原稿) でなければ 404。
 * - 選んだ声の決まった文がまだ無い (初めて使う声) ときは、すぐ鳴らせる既定の声の音を返し、
 *   選んだ声は後ろで合成しておく (緊急地震速報の冒頭を待たせない)。どの声かは `x-voice` で返す。
 * - 使われている声がもう上限まであって、選んだ声を足せないときは、既定の声で読む。
 * - それ以外は、選んだ声で合成を待つ (受けたときに合成を始めているので、たいていは済んでいる)。
 */
export async function serveSpeech(
  v: Voicevox,
  req: SpeechRequest,
): Promise<Response> {
  const text = req.text;
  if (!v.isAllowed(text))
    return new Response("この文は読み上げられません", { status: 404 });
  if (!v.available)
    return new Response("VOICEVOX につながりません", { status: 503 });
  let chosen =
    req.voice !== undefined && v.isVoice(req.voice)
      ? req.voice
      : v.defaultSpeaker;
  v.use(chosen);
  if (!v.isActive(chosen)) chosen = v.defaultSpeaker;
  const speaker =
    isFixed(text) &&
    text !== SAMPLE &&
    !v.isCached(chosen, text) &&
    v.isCached(v.defaultSpeaker, text)
      ? v.defaultSpeaker
      : chosen;
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
