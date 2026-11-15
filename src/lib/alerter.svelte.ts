/**
 * 開いているときの通知・音・読み上げ (docs/design.md の 2.4)。SSE で受けたイベントを、Web Push と同じ判定
 * (`#lib/notify.ts` の noticeOf・decide) にかけ、鳴らすときだけ OS の通知と短い音 (`<audio>`) と読み上げをする。
 *
 * - OS の通知 (`showNotification`) は、通知の許可があれば操作の前でも OS の通知音で鳴る。中身は Web Push と
 *   同じ (`pageNotification`)。同じ事象が Web Push でも届くときは、後から出すほうが鳴らさない (`isShown`)。
 *   チャイムが鳴ったときは、通知を音なし (`silent`) で出して 2 つの音を重ねない。
 *
 * - 読み上げの原稿は `#lib/readout.ts` で作る。声はサーバーが VOICEVOX で合成したもの (`/api/speech`) を
 *   文ごとに取って順に鳴らす。VOICEVOX が止まっている・取れない文は、端末の読み上げ (`speechSynthesis`) で読む。
 * - 音・読み上げのオン/オフと鳴らす条件は端末ごとに localStorage に持つ (既定は音も読み上げもオフ)。
 *   条件は Web Push のダイアログと同じもの (`PushPrefs`)。声はこの家で 1 つで、サーバーに持つ
 *   (`PUT /api/speech`。替わったら SSE の `event: voice` で届く)。
 * - ブラウザは、人がページを一度操作するまで音を出させない (自動再生の制限)。最初の操作で `<audio>` と
 *   読み上げを一度だけ無音で動かして、後から鳴らせるようにする。鳴らせない間は `blocked` が立ち、
 *   画面の上の端に帯 (押すと鳴らせるようになる) を出す。
 * - 同じ事象の続報で何度も鳴らさない (控えはメモリに持つ。読み直したら忘れる)。
 *   タブを幾つも開いていても 1 つだけが鳴らす (Web Locks)。
 */

import {
  ALERT_OFF,
  type AlertSettings,
  autoplayAllowed,
  notifyOn,
  pageNotification,
  parseAlertPrefs,
  parseAlertSettings,
  type Permission,
  planAlert,
} from "./alert.ts";
import { chimeWav } from "./chime.ts";
import {
  CONNECTION_TAG,
  connectionNotification,
  type OutageSignal,
  OutageWatch,
} from "./connection.ts";
import type { SonaeEvent } from "./model.ts";
import { contentOf, type Notice, type Sent } from "./notify.ts";
import { readPref, writePref } from "./prefs.ts";
import {
  DEFAULT_PREFS,
  isShown,
  normalizePrefs,
  type PushPrefs,
} from "./push.ts";
import { CONNECTION, readoutOf, SAMPLE } from "./readout.ts";
import { creditOf, type SpeechInfo } from "./voices.ts";

/** 控えを持つ数の上限 (長く開いたままでも増え続けない) */
const SENT_MAX = 200;
/** 音 (チャイムか OS の通知音) の後に読み上げるまでの間 (ミリ秒。音と声を重ねない) */
const SPEAK_AFTER_MS = 750;
/** チャイムが鳴り始めるのを待つ長さ。過ぎたら鳴らなかったとみなし、通知を OS の通知音で出す */
const CHIME_WAIT_MS = 300;

const permissionNow = (): Permission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

class Alerter {
  settings = $state<AlertSettings>({ ...ALERT_OFF });
  prefs = $state<PushPrefs>({ ...DEFAULT_PREFS });
  /** 人がページを操作した (ブラウザが音を出させる) */
  activated = $state(false);
  /** 開いたときから自動再生を許している (操作の前でも `<audio>` を鳴らせる) */
  autoplay = $state(false);
  /** 操作の後でも、ブラウザが音を止めた */
  failed = $state(false);
  /** サーバーの VOICEVOX (選べる声)。読めるまでは無い */
  speech = $state<SpeechInfo>();
  /** 通知の許可 (ブラウザのサイトの設定で変わることがあるので、見えるようになったときに読み直す) */
  permission = $state<Permission>("unsupported");
  readonly speechSupported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  private audio: HTMLAudioElement | undefined;
  private voiceAudio: HTMLAudioElement | undefined;
  private url: string | undefined;
  private readonly sent = new Map<string, Sent>();
  /** 受信が切れた・戻ったを知らせるかの判定 (start で作り直す) */
  private outage = new OutageWatch(Date.now());
  /** 前もって取った、受信が切れた・戻ったときの文の音 (声と文ごと) */
  private readonly kept = new Map<string, Blob>();
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

  /** この家で読む声 (サーバーに 1 つ。全部の端末で同じ) */
  get voiceId(): number | undefined {
    return this.speech?.voice;
  }

  /** 読む声のクレジット。この端末で VOICEVOX で読み上げていないときは空 */
  get credits(): string[] {
    if (!this.settings.speech || !this.speech?.available) return [];
    const v = this.speech.voices.find((x) => x.id === this.speech?.voice);
    return v ? [creditOf(v)] : [];
  }

  /** 開いているときに OS の通知を出す (許可があり、スイッチを切っていない) */
  get notifying(): boolean {
    return notifyOn(this.settings, this.permission);
  }

  /** 音か読み上げがオンなのに、いまは鳴らせない */
  get blocked(): boolean {
    return (
      (this.settings.sound || (this.settings.speech && this.canSpeak)) &&
      (!this.ready || this.failed)
    );
  }

  /**
   * 鳴らせる状態か。自動再生を許していても、端末の読み上げ (speechSynthesis) は操作の前だと断られることが
   * あり、断られても分からないので、読み上げがオンで VOICEVOX が使えないときは操作を待つ
   */
  private get ready(): boolean {
    return (
      this.activated ||
      (this.autoplay && (!this.settings.speech || this.voicevox))
    );
  }

  /** 覚えた設定を読み、最初の操作を待つ。止めるときに呼ぶ関数を返す */
  start(): () => void {
    const raw = readPref("alert");
    this.settings = parseAlertSettings(raw);
    // 前は声を端末ごとに `voice` に持っていた。読まずに消す (読めた値だけで書き直す)
    if (raw !== null && raw.includes('"voice"'))
      writePref("alert", JSON.stringify(this.settings));
    this.prefs = parseAlertPrefs(readPref("alert.prefs"));
    // 自動再生を許している (アプリとして入れた・サイトの設定で許した) ブラウザでは、押さなくても鳴らせる
    this.activated = navigator.userActivation?.hasBeenActive ?? false;
    this.autoplay = autoplayAllowed(navigator, globalThis.AudioContext);
    this.permission = permissionNow();
    this.outage = new OutageWatch(Date.now());
    void this.loadSpeech();
    const onGesture = () => this.unlock();
    const events = ["pointerup", "keydown", "touchend"] as const;
    for (const t of events)
      window.addEventListener(t, onGesture, { capture: true, passive: true });
    // 通知の許可はサイトの設定で変わる。画面に戻ったときに読み直す
    const onVisible = () => {
      if (document.visibilityState === "visible")
        this.permission = permissionNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    // VOICEVOX が後からつながったときのために、ときどき読み直す
    const timer = setInterval(() => void this.loadSpeech(), 5 * 60_000);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
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

  /** 選べる声と、この家で読む声を読む */
  async loadSpeech(): Promise<void> {
    try {
      const res = await fetch("/api/speech");
      if (res.ok) this.speech = (await res.json()) as SpeechInfo;
    } catch {
      // 読めなければ端末の読み上げで読む
    }
    void this.keepConnectionVoice();
  }

  /**
   * この家の声を替える (サーバーに保存し、全部の端末に伝わる)。保存できたら null、できなければわけ
   */
  async saveVoice(voice: number): Promise<string | null> {
    try {
      const res = await fetch("/api/speech", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice }),
      });
      if (!res.ok)
        return res.status === 401
          ? "ログインが切れています。読み直してください"
          : `保存できませんでした (${res.status})`;
      this.speech = (await res.json()) as SpeechInfo;
      void this.keepConnectionVoice();
      return null;
    } catch {
      return "保存できませんでした (つながりません)";
    }
  }

  /** ほかの端末 (または自分) が声を替えた (SSE の `event: voice`。つないだときにも来る) */
  applyVoice(voice: number): void {
    if (!this.speech || this.speech.voice === voice) return;
    // 一覧に無い声なら (エンジンが替わったなど) 読み直す
    if (!this.speech.voices.some((v) => v.id === voice)) {
      void this.loadSpeech();
      return;
    }
    this.speech = { ...this.speech, voice };
    void this.keepConnectionVoice();
  }

  /**
   * 受信が切れた・戻ったときの文の音を、前もって取っておく (切れている間はサーバーに取りに行けない)。
   * 読み上げがオンで VOICEVOX が使えるときだけ。声が替わったら取り直す
   */
  private async keepConnectionVoice(): Promise<void> {
    if (!this.settings.speech || !this.voicevox) return;
    const voice = this.voiceId;
    // 前の声の音は捨てる
    for (const key of this.kept.keys())
      if (!key.startsWith(`${voice}\n`)) this.kept.delete(key);
    for (const text of Object.values(CONNECTION)) {
      const key = `${voice}\n${text}`;
      if (this.kept.has(key)) continue;
      try {
        const res = await fetch("/api/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        // 取りに行く間に声が替わったら、前の声の音は持たない
        if (!res.ok || res.headers.get("x-voice") !== String(voice)) continue;
        this.kept.set(key, await res.blob());
      } catch {
        // 取れなければ、切れたときは端末の読み上げで読む
      }
    }
  }

  /**
   * 画面への配信 (SSE) がつながっているか。`live.connect` がときどきと、変わったときに呼ぶ。
   * 切れたまま 30 秒続いたら「受信が切れました」、その後に戻ったら「受信が戻りました」を知らせる
   * (`#lib/connection.ts` の OutageWatch)。スイッチ (`outage`) を切っていれば知らせない
   */
  connection(connected: boolean): void {
    const signal = this.outage.update(connected, Date.now());
    if (!signal || this.settings.outage === false) return;
    // 同じ画面のタブが幾つあっても 1 つだけが知らせる (タブごとに見ているので、少し長めに持つ)
    void this.once(`connection:${signal}`, () => this.announce(signal), 60_000);
  }

  /**
   * 受信が切れた・戻ったことを知らせる。切れたときは、事象と同じくチャイム・OS の通知・読み上げ
   * (オンにしているものだけ)。戻ったときは短く、読み上げと、切れたときの通知の音なしの置き換えだけ
   */
  private async announce(signal: OutageSignal): Promise<void> {
    const { sound, speech } = this.settings;
    const down = signal === "down";
    const text = down ? CONNECTION.down : CONNECTION.back;
    const reads = speech && this.canSpeak;
    this.rings++;
    const chimed = down && sound ? await this.chime() : false;
    const notified = this.notifying
      ? await this.showConnection(signal, chimed)
      : false;
    if (!reads) return;
    const blob = this.kept.get(`${this.voiceId}\n${text}`) ?? null;
    const pending = new Map([[text, Promise.resolve(blob)]]);
    const go = () => void this.speak([text], pending);
    if (chimed || notified) setTimeout(go, SPEAK_AFTER_MS);
    else go();
  }

  /** 受信が切れた・戻ったときの OS の通知。戻ったときは、切れたときの通知が残っていれば置き換えるだけ */
  private async showConnection(
    signal: OutageSignal,
    chimed: boolean,
  ): Promise<boolean> {
    try {
      const reg = await this.registration();
      if (!reg) return false;
      const shape = connectionNotification(signal, chimed);
      if (signal === "back") {
        const shown = await reg.getNotifications({ tag: CONNECTION_TAG });
        if (shown.length === 0) return false;
      }
      await reg.showNotification(
        shape.title,
        shape.options as NotificationOptions,
      );
      return !shape.options.silent;
    } catch {
      return false;
    }
  }

  setSettings(next: AlertSettings): void {
    const speechOn = next.speech && !this.settings.speech;
    this.settings = { ...next };
    writePref("alert", JSON.stringify(this.settings));
    if (speechOn) void this.loadSpeech();
  }

  setPrefs(next: PushPrefs): void {
    this.prefs = normalizePrefs(next);
    writePref("alert.prefs", JSON.stringify(this.prefs));
  }

  /**
   * 開いているときの通知のスイッチ。オンにするとき、まだ許可を聞いていなければ聞く
   * (人がスイッチを押した操作の中で呼ぶ。許可は操作の中でしか求めない)
   */
  async setNotify(on: boolean): Promise<Permission> {
    this.setSettings({ ...this.settings, notify: on });
    this.lastAskMs = undefined;
    if (on && this.permission === "default") {
      const t0 = performance.now();
      this.permission = await Notification.requestPermission().catch(() =>
        permissionNow(),
      );
      this.lastAskMs = performance.now() - t0;
    }
    return this.permission;
  }

  /** 直前の setNotify で許可を聞いたときに、答えが返るまでのミリ秒 (聞かなかったときは無し)。窓を出さずに断られたかを見る */
  lastAskMs: number | undefined;

  /** 通知の許可を読み直す (Web Push の登録で許可を求めた後など) */
  refreshPermission(): void {
    this.permission = permissionNow();
  }

  /** SSE で受けたイベント (live が新しいと判定したものだけ) */
  handle(e: SonaeEvent): void {
    // オフの間も控えは付ける (オンにした直後に、前から続いている事象の続報で鳴らさない)
    const p = planAlert(e, Date.now(), this.prefs, this.sent);
    if (this.sent.size > SENT_MAX) {
      const oldest = this.sent.keys().next().value;
      if (oldest !== undefined) this.sent.delete(oldest);
    }
    if (!p) return;
    const n = p.notice;
    const notify = this.notifying;
    if (!p.renotify) {
      // 鳴らさない続報 (取消・解除・震源が決まった) は、この画面が出した通知が残っていれば置き換えるだけ
      if (notify) void this.replace(n);
      return;
    }
    if (notify || this.settings.sound || this.settings.speech)
      void this.once(`${n.tag}\n${contentOf(n)}`, () => this.ring(n, notify));
  }

  /** 試しに鳴らす (ダイアログのボタン。押した操作の中なので、鳴らせるようにもなる) */
  preview(): void {
    // 音は ring がこの操作の中で鳴らすので、無音で動かすのは読み上げだけにする
    // (無音の再生を止める pause で、鳴らした音が切れないように)
    this.unlock(false);
    void this.ring(null, false);
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
  private async once(
    key: string,
    run: () => unknown,
    holdMs = 5000,
  ): Promise<void> {
    const locks =
      typeof navigator !== "undefined" ? navigator.locks : undefined;
    // 鳴らせないタブはロックを取らない (操作済みのほかのタブが鳴らせるように)。自分でも鳴らしてはみる
    // (通知は、同じ中身がもう出ていれば出さないので、2 つのタブが出しても 2 度は鳴らない)
    if (!locks || this.blocked) {
      run();
      return;
    }
    await locks.request(
      `sonae.alert:${key}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        run();
        // 同じ SSE のイベントがほかのタブに届くまで持っておく
        await new Promise((r) => setTimeout(r, holdMs));
      },
    );
  }

  /**
   * 音を鳴らし、OS の通知を出し、原稿を読む (`n` が無ければ試しの文で、通知は出さない)。
   * チャイムが鳴れば通知は音なしで出し (2 つの音を重ねない)、鳴らなければ OS の通知音に任せる。
   * どちらかの音が鳴ったら、少しおいてから読む
   */
  private async ring(n: Notice | null, notify: boolean): Promise<void> {
    const { sound, speech } = this.settings;
    const reads = speech && this.canSpeak;
    const parts = reads ? (n ? readoutOf(n) : [SAMPLE]) : [];
    // 音を合わせて待つ間に、最初の文を取りに行っておく
    const pending = parts.length > 0 ? this.fetchAll(parts) : undefined;
    this.rings++;
    // play はこの同期の中で呼ぶ (「試しに鳴らす」の操作の中で鳴らすため)
    const chime = sound ? this.chime() : Promise.resolve(false);
    const chimed = notify ? await chime : false;
    const notified = n && notify ? await this.show(n, chimed) : false;
    if (!pending) return;
    const go = () => void this.speak(parts, pending);
    if (sound || notified) setTimeout(go, SPEAK_AFTER_MS);
    else go();
  }

  /** チャイムを鳴らす。鳴り始めたら true (待ちすぎたら false) */
  private chime(): Promise<boolean> {
    const a = this.element();
    a.muted = false;
    a.currentTime = 0;
    const played = a
      .play()
      .then(() => {
        this.failed = false;
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "NotAllowedError")
          this.failed = true;
        return false;
      });
    return Promise.race([
      played,
      new Promise<boolean>((r) => setTimeout(() => r(false), CHIME_WAIT_MS)),
    ]);
  }

  /** Service Worker の登録 (まだ無ければ無い。通知はこれで出す) */
  private async registration(): Promise<ServiceWorkerRegistration | undefined> {
    if (!("serviceWorker" in navigator)) return undefined;
    return navigator.serviceWorker.getRegistration().catch(() => undefined);
  }

  /**
   * OS の通知を出す。同じ事象の同じ中身がもう出ていれば (Web Push が先に届いた・ほかのタブが出した)
   * 出さない。OS の通知音で鳴らしたら true
   */
  private async show(n: Notice, chimed: boolean): Promise<boolean> {
    try {
      const reg = await this.registration();
      if (!reg) return false;
      // チャイムが鳴ったら音なしで出す。音なしで鳴らし直す (renotify) ことは無いので、renotify は付けない
      // (silent と renotify を一緒に付けると投げるブラウザがあっても、通知を落とさないように)
      const shape = pageNotification(n, !chimed, chimed);
      if (
        isShown(shape, await reg.getNotifications({ tag: shape.options.tag }))
      )
        return false;
      try {
        // renotify・silent は DOM の型に無いことがあるので、自分で書いた形で渡す
        await reg.showNotification(
          shape.title,
          shape.options as NotificationOptions,
        );
        return !chimed;
      } catch {
        // 音なしの形を受け付けないブラウザでは、通知音つきで出し直す (出さないよりよい)
        const plain = pageNotification(n, true, false);
        await reg.showNotification(
          plain.title,
          plain.options as NotificationOptions,
        );
        return true;
      }
    } catch {
      return false;
    }
  }

  /** 鳴らさない続報で、この事象の通知が出ていれば置き換える (取消・解除を残った通知に映す) */
  private async replace(n: Notice): Promise<void> {
    try {
      const reg = await this.registration();
      if (!reg) return;
      const shape = pageNotification(n, false, true);
      const shown = await reg.getNotifications({ tag: shape.options.tag });
      if (shown.length === 0 || isShown(shape, shown)) return;
      await reg.showNotification(
        shape.title,
        shape.options as NotificationOptions,
      );
    } catch {
      // 置き換えられなくても、前の通知が残るだけ
    }
  }

  /** 文ごとの音を取りに行く (同じ文は 1 回)。VOICEVOX が無ければ空 */
  private fetchAll(parts: string[]): Map<string, Promise<Blob | null>> {
    const out = new Map<string, Promise<Blob | null>>();
    if (!this.voicevox) return out;
    for (const text of parts) {
      if (out.has(text)) continue;
      out.set(
        text,
        fetch("/api/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
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
