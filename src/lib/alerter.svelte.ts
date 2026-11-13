/**
 * 開いているときの音と読み上げ (docs/design.md の 2.4)。SSE で受けたイベントを、Web Push と同じ判定
 * (`#lib/notify.ts` の noticeOf・decide) にかけ、鳴らすときだけ短い音 (`<audio>`) と見出しの読み上げ
 * (`speechSynthesis`) をする。
 *
 * - 音・読み上げのオン/オフと、鳴らす条件は端末ごとに localStorage に持つ (既定はどちらもオフ)。
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
  spokenText,
} from "./alert.ts";
import { chimeWav } from "./chime.ts";
import type { SonaeEvent } from "./model.ts";
import { contentOf, type Sent } from "./notify.ts";
import { readPref, writePref } from "./prefs.ts";
import { DEFAULT_PREFS, normalizePrefs, type PushPrefs } from "./push.ts";

/** 控えを持つ数の上限 (長く開いたままでも増え続けない) */
const SENT_MAX = 200;
/** 音の後に読み上げるまでの間 (ミリ秒。音と声を重ねない) */
const SPEAK_AFTER_MS = 750;

class Alerter {
  settings = $state<AlertSettings>({ ...ALERT_OFF });
  prefs = $state<PushPrefs>({ ...DEFAULT_PREFS });
  /** 人がページを操作した (ブラウザが音を出させる) */
  activated = $state(false);
  /** 操作の後でも、ブラウザが音を止めた */
  failed = $state(false);
  readonly speechSupported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  private audio: HTMLAudioElement | undefined;
  private url: string | undefined;
  private readonly sent = new Map<string, Sent>();
  /** 鳴らした回数。無音で動かしている間に本当に鳴らしたら、その音を止めない */
  private rings = 0;

  /** 音か読み上げがオンなのに、いまは鳴らせない */
  get blocked(): boolean {
    return (
      (this.settings.sound || (this.settings.speech && this.speechSupported)) &&
      (!this.activated || this.failed)
    );
  }

  /** 覚えた設定を読み、最初の操作を待つ。止めるときに呼ぶ関数を返す */
  start(): () => void {
    this.settings = parseAlertSettings(readPref("alert"));
    this.prefs = parseAlertPrefs(readPref("alert.prefs"));
    this.activated = navigator.userActivation?.hasBeenActive ?? false;
    const onGesture = () => this.unlock();
    const events = ["pointerup", "keydown", "touchend"] as const;
    for (const t of events)
      window.addEventListener(t, onGesture, { capture: true, passive: true });
    return () => {
      for (const t of events)
        window.removeEventListener(t, onGesture, { capture: true });
      this.audio?.pause();
      if (this.url) URL.revokeObjectURL(this.url);
      this.audio = undefined;
      this.url = undefined;
    };
  }

  setSettings(next: AlertSettings): void {
    this.settings = { ...next };
    writePref("alert", JSON.stringify(this.settings));
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
      void this.once(`${n.tag}\n${contentOf(n)}`, () => this.ring(n.title));
  }

  /** 試しに鳴らす (ダイアログのボタン。押した操作の中なので、鳴らせるようにもなる) */
  preview(): void {
    // 音は ring がこの操作の中で鳴らすので、無音で動かすのは読み上げだけにする
    // (無音の再生を止める pause で、鳴らした音が切れないように)
    this.unlock(false);
    this.ring("sonae の通知の試しです");
  }

  /**
   * 人の操作の中で、音と読み上げを無音で一度動かす。iPhone・iPad の Safari は、操作の中で一度
   * 鳴らした `<audio>` と読み上げでないと、後から鳴らせない
   */
  unlock(primeAudio = true): void {
    this.activated = true;
    this.failed = false;
    if (primeAudio && this.settings.sound) {
      const a = this.element();
      if (a.paused) {
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
    }
    if (
      this.settings.speech &&
      this.speechSupported &&
      !speechSynthesis.speaking
    ) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }

  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.url = URL.createObjectURL(
        new Blob([chimeWav()], { type: "audio/wav" }),
      );
      this.audio = new Audio(this.url);
      this.audio.preload = "auto";
    }
    return this.audio;
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

  private ring(title: string): void {
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
    if (speech && this.speechSupported) {
      const say = () => {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(spokenText(title));
        u.lang = "ja-JP";
        const voice = speechSynthesis
          .getVoices()
          .find((v) => v.lang.replace("_", "-").startsWith("ja"));
        if (voice) u.voice = voice;
        speechSynthesis.speak(u);
      };
      if (sound) setTimeout(say, SPEAK_AFTER_MS);
      else say();
    }
  }
}

export const alerter = new Alerter();
