/**
 * 開いているときの音と読み上げ (docs/design.md の 2.4)。SSE で受けたイベントを、Web Push と同じ判定
 * (`#lib/notify.ts` の noticeOf・decide) にかけ、鳴らすときだけ短い音 (`<audio>`) と読み上げをする。
 *
 * - 読み上げの原稿は `#lib/readout.ts` で作る。声はサーバーが VOICEVOX で合成したもの (`/api/speech`) を
 *   文ごとに取って順に鳴らす。VOICEVOX が止まっている・取れない文は、端末の読み上げ (`speechSynthesis`) で読む。
 * - 音・読み上げのオン/オフ、声、鳴らす条件は端末ごとに localStorage に持つ (既定は音も読み上げもオフ)。
 *   条件は Web Push のダイアログと同じもの (`PushPrefs`)。
 * - ブラウザは、人がページを一度操作するまで音を出させない (自動再生の制限)。最初の操作で `<audio>` と
 *   読み上げを一度だけ無音で動かして、後から鳴らせるようにする。鳴らせない間は `blocked` が立ち、
 *   画面 (ヘッダー・dock) に「音を出す」を出す。
 * - 同じ事象の続報で何度も鳴らさない (控えはメモリに持つ。読み直したら忘れる)。
 *   タブを幾つも開いていても 1 つだけが鳴らす (Web Locks)。
 */

import {
  ALERT_OFF,
  alertFor,
  type AlertSettings,
  parseAlertPrefs,
  parseAlertSettings,
} from "./alert.ts";
import { chimeWav } from "./chime.ts";
import type { SonaeEvent } from "./model.ts";
import { contentOf, type Notice, type Sent } from "./notify.ts";
import { readPref, writePref } from "./prefs.ts";
import { DEFAULT_PREFS, normalizePrefs, type PushPrefs } from "./push.ts";
import { readoutOf, SAMPLE } from "./readout.ts";
import { creditOf, type SpeechInfo, type Voice } from "./voices.ts";

/** 控えを持つ数の上限 (長く開いたままでも増え続けない) */
const SENT_MAX = 200;
/** 音の後に読み上げるまでの間 (ミリ秒。音と声を重ねない) */
const SPEAK_AFTER_MS = 750;

/**
 * 操作の前でも音を出せるか。Firefox は `navigator.getAutoplayPolicy` で分かる。無いブラウザは、
 * 作った AudioContext がすぐ動くか (自動再生を許していなければ suspended で作られる) で見る。
 * 分からなければ出せないとみなす (「音を出す」を出す側に倒す。鳴らすのに失敗したときも出る)
 */
function autoplayAllowed(): boolean {
  const nav = navigator as Navigator & {
    getAutoplayPolicy?: (type: "mediaelement") => string;
  };
  try {
    if (nav.getAutoplayPolicy)
      return nav.getAutoplayPolicy("mediaelement") === "allowed";
    if (typeof AudioContext === "undefined") return false;
    const ctx = new AudioContext();
    const running = ctx.state === "running";
    void ctx.close();
    return running;
  } catch {
    return false;
  }
}

class Alerter {
  settings = $state<AlertSettings>({ ...ALERT_OFF });
  prefs = $state<PushPrefs>({ ...DEFAULT_PREFS });
  /** 人がページを操作した (ブラウザが音を出させる) */
  activated = $state(false);
  /** 操作の後でも、ブラウザが音を止めた */
  failed = $state(false);
  /** サーバーの VOICEVOX (選べる声)。読めるまでは無い */
  speech = $state<SpeechInfo>();
  readonly speechSupported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  private audio: HTMLAudioElement | undefined;
  private voiceAudio: HTMLAudioElement | undefined;
  private url: string | undefined;
  private readonly sent = new Map<string, Sent>();
  /** 鳴らした回数。無音で動かしている間に本当に鳴らしたら、その音を止めない */
  private rings = 0;
  /** 読み上げの回数。新しい読み上げが始まったら、前のものを止める */
  private speaking = 0;
  /** 読み上げている最中 (文と文の間に、無音で動かして割り込まない) */
  private reading = false;

  /** VOICEVOX で読める */
  get voicevox(): boolean {
    return this.speech?.available === true;
  }

  /** 読み上げられる (VOICEVOX か、端末の読み上げ) */
  get canSpeak(): boolean {
    return this.voicevox || this.speechSupported;
  }

  /** 選んでいる声 (無ければサーバーの既定の声) */
  get voiceId(): number | undefined {
    const chosen = this.settings.voice;
    if (
      chosen !== undefined &&
      this.speech?.voices.some((v) => v.id === chosen)
    )
      return chosen;
    return this.speech?.defaultSpeaker;
  }

  /**
   * この端末で鳴る声のクレジット。選んだ声と、まだ選んだ声で合成できていないときに冒頭を読む既定の声。
   * VOICEVOX で読み上げていないときは空
   */
  get credits(): string[] {
    if (!this.settings.speech || !this.speech?.available) return [];
    const ids = [this.voiceId, this.speech.defaultSpeaker];
    const voices = ids
      .map((id) => this.speech?.voices.find((v) => v.id === id))
      .filter((v): v is Voice => v !== undefined);
    return [...new Set(voices.map(creditOf))];
  }

  /** 音か読み上げがオンなのに、いまは鳴らせない */
  get blocked(): boolean {
    return (
      (this.settings.sound || (this.settings.speech && this.canSpeak)) &&
      (!this.activated || this.failed)
    );
  }

  /** 覚えた設定を読み、最初の操作を待つ。止めるときに呼ぶ関数を返す */
  start(): () => void {
    this.settings = parseAlertSettings(readPref("alert"));
    this.prefs = parseAlertPrefs(readPref("alert.prefs"));
    // 自動再生を許している (アプリとして入れた・サイトの設定で許した) ブラウザでは、押さなくても鳴らせる
    this.activated =
      (navigator.userActivation?.hasBeenActive ?? false) || autoplayAllowed();
    void this.loadSpeech();
    const onGesture = () => this.unlock();
    const events = ["pointerup", "keydown", "touchend"] as const;
    for (const t of events)
      window.addEventListener(t, onGesture, { capture: true, passive: true });
    // VOICEVOX が後からつながったときのために、ときどき読み直す
    const timer = setInterval(() => void this.loadSpeech(), 5 * 60_000);
    return () => {
      clearInterval(timer);
      for (const t of events)
        window.removeEventListener(t, onGesture, { capture: true });
      this.audio?.pause();
      this.voiceAudio?.pause();
      if (this.url) URL.revokeObjectURL(this.url);
      this.audio = undefined;
      this.voiceAudio = undefined;
      this.url = undefined;
    };
  }

  /**
   * 選べる声を読む。読み上げがオンなら、選んだ声を伝える (サーバーがその声の冒頭の文を合成しておく)
   */
  async loadSpeech(): Promise<void> {
    const q =
      this.settings.speech && this.settings.voice !== undefined
        ? `?voice=${this.settings.voice}`
        : "";
    try {
      const res = await fetch(`/api/speech${q}`);
      if (res.ok) this.speech = (await res.json()) as SpeechInfo;
    } catch {
      // 読めなければ端末の読み上げで読む
    }
  }

  setSettings(next: AlertSettings): void {
    const voiceChanged = next.voice !== this.settings.voice;
    const speechOn = next.speech && !this.settings.speech;
    this.settings = { ...next };
    writePref("alert", JSON.stringify(this.settings));
    if (voiceChanged || speechOn) void this.loadSpeech();
  }

  setPrefs(next: PushPrefs): void {
    this.prefs = normalizePrefs(next);
    writePref("alert.prefs", JSON.stringify(this.prefs));
  }

  /** SSE で受けたイベント (live が新しいと判定したものだけ) */
  handle(e: SonaeEvent): void {
    // オフの間も控えは付ける (オンにした直後に、前から続いている事象の続報で鳴らさない)
    const n = alertFor(e, Date.now(), this.prefs, this.sent);
    if (this.sent.size > SENT_MAX) {
      const oldest = this.sent.keys().next().value;
      if (oldest !== undefined) this.sent.delete(oldest);
    }
    if (n && (this.settings.sound || this.settings.speech))
      void this.once(`${n.tag}\n${contentOf(n)}`, () => this.ring(n));
  }

  /** 試しに鳴らす (ダイアログのボタン。押した操作の中なので、鳴らせるようにもなる) */
  preview(): void {
    // 音は ring がこの操作の中で鳴らすので、無音で動かすのは読み上げだけにする
    // (無音の再生を止める pause で、鳴らした音が切れないように)
    this.unlock(false);
    this.ring(null);
  }

  /** 選んだ声で試しの文だけを読む (「試しに聞く」) */
  previewVoice(): void {
    this.unlock(false);
    void this.speak([SAMPLE]);
  }

  /**
   * 人の操作の中で、音と読み上げを無音で一度動かす。iPhone・iPad の Safari は、操作の中で一度
   * 鳴らした `<audio>` と読み上げでないと、後から鳴らせない
   */
  unlock(primeAudio = true): void {
    this.activated = true;
    this.failed = false;
    if (primeAudio && this.settings.sound) this.prime(this.element());
    if (this.settings.speech) {
      // 声の `<audio>` は、鳴らしている最中でなければいつも無音で動かす
      const v = this.voiceElement();
      if (v.paused && !this.reading) this.prime(v);
      if (this.speechSupported && !speechSynthesis.speaking) {
        const u = new SpeechSynthesisUtterance("");
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    }
  }

  private prime(a: HTMLAudioElement): void {
    if (!a.paused) return;
    const at = this.rings;
    a.muted = true;
    a.play()
      .then(() => {
        if (at !== this.rings) return;
        a.pause();
        a.currentTime = 0;
      })
      .catch(() => {})
      .finally(() => {
        if (at === this.rings) a.muted = false;
      });
  }

  private chimeUrl(): string {
    this.url ??= URL.createObjectURL(
      new Blob([chimeWav()], { type: "audio/wav" }),
    );
    return this.url;
  }

  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio(this.chimeUrl());
      this.audio.preload = "auto";
    }
    return this.audio;
  }

  /** 読み上げの音を鳴らす `<audio>`。無音で動かすときは音と同じ WAV を使う */
  private voiceElement(): HTMLAudioElement {
    if (!this.voiceAudio) {
      this.voiceAudio = new Audio(this.chimeUrl());
      this.voiceAudio.preload = "auto";
    }
    return this.voiceAudio;
  }

  /** ほかのタブが同じものを鳴らしていたら鳴らさない (Web Locks が無ければ、いつも鳴らす) */
  private async once(key: string, run: () => void): Promise<void> {
    const locks =
      typeof navigator !== "undefined" ? navigator.locks : undefined;
    // 鳴らせないタブはロックを取らない (操作済みのほかのタブが鳴らせるように)。自分でも鳴らしてはみる
    if (!locks || this.blocked) return run();
    await locks.request(
      `sonae.alert:${key}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        run();
        // 同じ SSE のイベントがほかのタブに届くまで持っておく
        await new Promise((r) => setTimeout(r, 5000));
      },
    );
  }

  /** 音を鳴らし、原稿を読む (`n` が無ければ試しの文) */
  private ring(n: Notice | null): void {
    const { sound, speech } = this.settings;
    this.rings++;
    if (sound) {
      const a = this.element();
      a.muted = false;
      a.currentTime = 0;
      a.play()
        .then(() => (this.failed = false))
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "NotAllowedError")
            this.failed = true;
        });
    }
    if (!speech || !this.canSpeak) return;
    const parts = n ? readoutOf(n) : [SAMPLE];
    if (parts.length === 0) return;
    // 音を合わせて待つ間に、最初の文を取りに行っておく
    const pending = this.fetchAll(parts);
    const go = () => void this.speak(parts, pending);
    if (sound) setTimeout(go, SPEAK_AFTER_MS);
    else go();
  }

  /** 文ごとの音を取りに行く (同じ文は 1 回)。VOICEVOX が無ければ空 */
  private fetchAll(parts: string[]): Map<string, Promise<Blob | null>> {
    const out = new Map<string, Promise<Blob | null>>();
    if (!this.voicevox) return out;
    const voice = this.voiceId;
    for (const text of parts) {
      if (out.has(text)) continue;
      out.set(
        text,
        fetch("/api/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice }),
        })
          .then((r) => (r.ok ? r.blob() : null))
          .catch(() => null),
      );
    }
    return out;
  }

  /**
   * 文を順に読む。VOICEVOX の音が取れた文はそれを鳴らし、取れなかった文は端末の読み上げで読む。
   * 新しい読み上げが始まったら、そこで止める
   */
  private async speak(
    parts: string[],
    pending = this.fetchAll(parts),
  ): Promise<void> {
    const id = ++this.speaking;
    this.voiceAudio?.pause();
    if (this.speechSupported) speechSynthesis.cancel();
    this.reading = true;
    try {
      for (const text of parts) {
        if (id !== this.speaking) return;
        const blob = await pending.get(text);
        if (id !== this.speaking) return;
        if (blob) await this.play(blob);
        else await this.say(text);
      }
    } finally {
      if (id === this.speaking) this.reading = false;
    }
  }

  /** VOICEVOX の音を鳴らし、終わるまで待つ */
  private async play(blob: Blob): Promise<void> {
    const a = this.voiceElement();
    const url = URL.createObjectURL(blob);
    try {
      a.muted = false;
      a.src = url;
      await new Promise<void>((resolve) => {
        const done = () => {
          a.removeEventListener("ended", done);
          a.removeEventListener("error", done);
          a.removeEventListener("pause", done);
          resolve();
        };
        a.addEventListener("ended", done);
        a.addEventListener("error", done);
        a.addEventListener("pause", done);
        a.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "NotAllowedError")
            this.failed = true;
          done();
        });
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 端末の読み上げで 1 文を読み、終わるまで待つ */
  private say(text: string): Promise<void> {
    if (!this.speechSupported) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      const voice = speechSynthesis
        .getVoices()
        .find((v) => v.lang.replace("_", "-").startsWith("ja"));
      if (voice) u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}

export const alerter = new Alerter();
