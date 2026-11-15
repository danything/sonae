<script lang="ts">
  /**
   * 通知の条件と、開いているときの音・読み上げと、Web Push の登録 (docs/design.md の 2.4)。
   * ヘッダーのナビ (スマホの形は下のタブ) の「通知」から開くダイアログ 1 つに閉じる。
   * 開け閉めは `open` で持つ (閉じるのは左下の「閉じる」・幕・Esc)。
   * 条件はブラウザごとに 1 つで、音・読み上げのために端末 (localStorage) に、Web Push のためにサーバー (購読) に持つ。
   * サーバーに VAPID の鍵が無いときは、Web Push の節にそう出すだけ (条件と音・読み上げは使える)。
   */
  import "@anyblades/blades/components/modal";

  import { goto } from "$app/navigation";

  import { alerter } from "#lib/alerter.svelte.ts";
  import { EDGE_SLEEP_HINT, isDesktopEdge } from "#lib/awake.ts";
  import { byPrefecture, type Cities, homeOf } from "#lib/home.ts";
  import { INTENSITIES, intensityLabel } from "#lib/model.ts";
  import {
    homeAt,
    loadCities as readCities,
    prefsSettled,
    pushBlock,
    type PushInfo,
    queuePrefs,
    readPushState,
    sendPrefs,
  } from "#lib/push-client.ts";
  import {
    permissionDeniedText,
    type PushBlock,
    pushBlockText,
    QUIET_DENY_MS,
  } from "#lib/push-support.ts";
  import { DEFAULT_PREFS, normalizePrefs, type PushPrefs } from "#lib/push.ts";
  import { voiceLabel } from "#lib/voices.ts";

  let {
    open = $bindable(false),
    training,
    trainingHref,
  }: {
    open?: boolean;
    /** 一覧に緊急地震速報の訓練・試験も出しているか (URL の `training=1`) */
    training: boolean;
    /** 訓練・試験の出し入れを切り替えたリンク */
    trainingHref: string;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let info = $state<PushInfo>();
  /** Web Push を使えない訳 (機能が無い・届かない宛先を返した)。使えそうなら null */
  let block = $state<PushBlock | null>(null);
  let endpoint = $state<string>();
  let prefs = $state<PushPrefs>({ ...DEFAULT_PREFS });
  /** 住んでいる地域の候補 (市町村等の表) と、地震情報／細分区域の名前 */
  let cities = $state<Cities>({});
  let quakeNames = new Map<string, string>();
  const prefGroups = $derived(byPrefecture(cities));
  /** 選んでいる都道府県 (市町村等のコードの上 2 桁) */
  let pref = $state("");
  const prefCities = $derived(
    prefGroups.find((g) => g.cities[0]?.code.startsWith(pref))?.cities ?? [],
  );
  let locating = $state(false);
  let busy = $state(false);
  let message = $state("");

  /** 「ブラウザの通知の状態」に出す、ブラウザが答えている値 (開いたときに読む。サーバーには送らない) */
  let diag = $state<[string, string][]>([]);
  async function readDiag(): Promise<void> {
    const rows: [string, string][] = [];
    const q = async (f: () => Promise<string>): Promise<string> => {
      try {
        return await f();
      } catch (err) {
        return `読めない (${err instanceof Error ? err.name : String(err)})`;
      }
    };
    rows.push(["安全な接続 (https)", String(window.isSecureContext)]);
    rows.push([
      "Notification.permission",
      typeof Notification === "undefined" ? "無い" : Notification.permission,
    ]);
    rows.push([
      "permissions.query(notifications)",
      await q(async () =>
        navigator.permissions
          ? (
              await navigator.permissions.query({
                name: "notifications" as PermissionName,
              })
            ).state
          : "無い",
      ),
    ]);
    // Service Worker が登録されていないと `ready` は終わらないので、待つのは 2 秒まで
    // (待っている間も、ほかの行は出しておく)
    diag = [...rows];
    rows.push([
      "pushManager.permissionState",
      await q(async () => {
        if (!("serviceWorker" in navigator && "PushManager" in window))
          return "無い";
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
        ]);
        return reg
          ? await reg.pushManager.permissionState({ userVisibleOnly: true })
          : "Service Worker が用意できていない (2 秒待った)";
      }),
    ]);
    rows.push([
      "アプリとして開いている",
      String(matchMedia("(display-mode: standalone)").matches),
    ]);
    rows.push(["ブラウザ", navigator.userAgent]);
    diag = rows;
  }
  /** 条件を覚えたかどうか (条件のすぐ下に出す。Web Push の登録の知らせは下の message) */
  let prefsMessage = $state("");
  /** 開いているときの通知のスイッチの知らせ (許可されなかったとき) */
  let notifyMessage = $state("");
  /** 声を保存したかどうか (声の選択のすぐ下に出す) */
  let voiceMessage = $state("");
  let voiceSaving = $state(false);

  /**
   * 声は選んだらすぐサーバーに保存する (この家の全部の端末で同じ声になる)。保存している間は、
   * 選択と「試しに聞く」を止める (前の声で試しに聞かないように)
   */
  async function setVoice(select: HTMLSelectElement): Promise<void> {
    voiceSaving = true;
    voiceMessage = "保存しています…";
    const failed = await alerter.saveVoice(Number(select.value));
    voiceSaving = false;
    voiceMessage =
      failed ?? "保存しました。この家の全部の端末で、この声で読みます";
    // 保存できなかったときは選択を戻す (値が変わらないので、Svelte は書き直さない)
    if (failed && alerter.voiceId !== undefined)
      select.value = String(alerter.voiceId);
  }

  const others = $derived(
    info?.enabled
      ? info.subscriptions.filter((s) => s.endpoint !== endpoint)
      : [],
  );
  const registered = $derived(
    info?.enabled === true &&
      info.subscriptions.some((s) => s.endpoint === endpoint),
  );

  async function registration(): Promise<ServiceWorkerRegistration> {
    return navigator.serviceWorker.ready;
  }

  /** 条件は、このブラウザが Web Push に登録してあればその条件、無ければ端末に覚えた条件 */
  async function load(): Promise<void> {
    // 閉じて開き直したとき、送っている途中の条件より古い条件をサーバーから読まないよう、送り終わるのを待つ
    // (地図のメニューから住んでいる地域を送っている途中も同じ)
    await prefsSettled();
    message = "";
    prefsMessage = "";
    notifyMessage = "";
    alerter.refreshPermission();
    prefs = normalizePrefs(alerter.prefs);
    pref = prefs.home?.code.slice(0, 2) ?? "";
    if (Object.keys(cities).length === 0) void loadCities();
    block = pushBlock();
    let state: Awaited<ReturnType<typeof readPushState>>;
    try {
      state = await readPushState();
    } catch (err) {
      message = String(err instanceof Error ? err.message : err);
      return;
    }
    info = state.info;
    endpoint = state.endpoint;
    // 今の購読が届かない宛先なら、ここで分かる (readPushState が覚える)
    block = pushBlock();
    if (!info.enabled || block) return;
    const mine = info.subscriptions.find((s) => s.endpoint === endpoint);
    if (mine) {
      prefs = normalizePrefs(mine.prefs);
      pref = prefs.home?.code.slice(0, 2) ?? "";
    }
  }

  /**
   * 条件を変えたらすぐ端末に覚え、Web Push に登録してあればサーバーにも送る (保存のボタンは無い。押し忘れると覚えないため)。
   * 続けて変えたときに前の送信と追い越さないよう、送るのは 1 つずつ順に (`queuePrefs`。地図のメニューと同じ列)
   */
  function savePrefs(note = ""): void {
    alerter.setPrefs(prefs);
    if (!registered) {
      prefsMessage = `${note}保存しました`;
      return;
    }
    prefsMessage = `${note}保存しています…`;
    void queuePrefs(save).then((result) => {
      if (result !== null) prefsMessage = `${note}${result}`;
    });
  }

  function setSound(on: boolean): void {
    alerter.setSettings({ ...alerter.settings, sound: on });
    // 押した操作の中で鳴らして、音の大きさを確かめてもらう (鳴らせるようにもなる)
    if (on) alerter.preview();
  }
  function setSpeech(on: boolean): void {
    alerter.setSettings({ ...alerter.settings, speech: on });
    if (on) alerter.preview();
  }

  /** 開いているときの OS の通知。オンにするとき、まだ聞いていなければ許可を聞く (このスイッチの操作の中で) */
  async function setNotify(input: HTMLInputElement): Promise<void> {
    const want = input.checked;
    const p = await alerter.setNotify(want);
    // 許可されなかったときはスイッチを戻す (値が変わらないので、Svelte は書き直さない)
    input.checked = alerter.notifying;
    const ms = alerter.lastAskMs;
    notifyMessage =
      want && p !== "granted"
        ? permissionDeniedText(navigator.userAgent, {
            asked: ms !== undefined,
            quiet: ms !== undefined && ms < QUIET_DENY_MS,
          })
        : "";
  }

  /** 住んでいる地域の候補 (市町村等の表) と、地震情報／細分区域の名前 (地図と同じファイル) */
  async function loadCities(): Promise<void> {
    try {
      const t = await readCities();
      quakeNames = t.quakeNames;
      cities = t.cities;
    } catch {
      // 候補が出ないだけ
    }
  }

  function setHome(code: string): void {
    prefs.home = code ? homeOf(code, cities, quakeNames) : null;
  }

  /**
   * 端末の位置を 1 回だけ取り、入る市町村等を選ぶ。位置は端末の中で使うだけで、送るのは市町村等のコードだけ
   */
  function locate(): void {
    if (!("geolocation" in navigator)) {
      message = "このブラウザは位置を取れません。一覧から選んでください。";
      return;
    }
    locating = true;
    message = "";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          // 地図のメニューの「ここを住んでいる地域にする」と同じ探し方
          const home = await homeAt(pos.coords.latitude, pos.coords.longitude);
          if (home) {
            pref = home.code.slice(0, 2);
            prefs.home = home;
            savePrefs(`${home.name} を選びました。`);
          } else {
            message =
              "いまの位置が入る市町村が見つかりませんでした。一覧から選んでください。";
          }
        } catch (err) {
          message = `市町村を探せませんでした: ${err}`;
        } finally {
          locating = false;
        }
      },
      (err) => {
        locating = false;
        message =
          err.code === err.PERMISSION_DENIED
            ? "位置の利用が許可されていません。一覧から選んでください。"
            : "位置を取れませんでした。一覧から選んでください。";
      },
      { maximumAge: 10 * 60_000, timeout: 20_000 },
    );
  }

  // 開いたら、そのたびに購読と条件を読み直す
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      load().catch((err: unknown) => (message = `読めませんでした: ${err}`));
    } else if (!open && dialog.open) dialog.close();
  });

  /** 「このブラウザで受ける」。登録して条件を送り、読み直す。結果は下の message に出す */
  async function register(): Promise<void> {
    message = "";
    const result = await save();
    await load();
    // 届かない宛先だったときは、文を Web Push の節そのものに出すので重ねない
    message = block ? "" : result;
  }

  /**
   * 条件をサーバーに送り、結果の文を返す (画面には書かない。どこに出すかは呼ぶ側が決める)。
   * 送った後に条件を読み直さないのは、送っている間に変えた条件が戻るため
   */
  async function save(): Promise<string> {
    if (!info?.enabled) return "";
    busy = true;
    try {
      return await sendPrefs(info.publicKey, $state.snapshot(prefs));
    } finally {
      busy = false;
    }
  }

  async function remove(target: string | undefined): Promise<void> {
    if (!target) return;
    busy = true;
    try {
      if (target === endpoint) {
        const sub = await (await registration()).pushManager.getSubscription();
        await sub?.unsubscribe();
      }
      await fetch("/api/push", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: target }),
      });
      message = "解除しました";
      await load();
    } catch (err) {
      message = `解除できませんでした: ${err}`;
    } finally {
      busy = false;
    }
  }

  async function test(): Promise<void> {
    busy = true;
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      message = res.ok
        ? "送りました。届かないときは、端末の通知の設定を見てください。"
        : res.status === 429
          ? ((
              (await res.json().catch(() => null)) as {
                message?: string;
              } | null
            )?.message ??
            "試しの通知は続けて送れません。しばらくしてから送ってください")
          : `送れませんでした (${res.status})`;
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  closedby="any"
  aria-labelledby="push-title"
  onclose={() => (open = false)}
>
  <!--
    枠の外を押したら閉じる。dialog が画面いっぱいに広がっているので、closedby="any" だけでは
    外を押しても dialog の中を押した扱いになり閉じない (「出典と注意」の窓と同じ作り)
  -->
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box stack">
    <h1 id="push-title">通知</h1>
    <p class="small muted">
      条件はこのブラウザごとに覚え、開いているときの音・読み上げと Web Push
      の両方に使います。訓練・試験は知らせません。
    </p>
    <!-- 条件は変えたらすぐ覚える (change はここまで上がってくる) -->
    <div class="stack" onchange={() => savePrefs()}>
      <label>
        緊急地震速報
        <select bind:value={prefs.eew}>
          <option value="warning">警報だけ</option>
          <option value="all">予報も</option>
          <option value="off">知らせない</option>
        </select>
      </label>
      <label>
        地震 (最大震度)
        <select bind:value={prefs.quakeMinInt}>
          {#each INTENSITIES as i (i)}
            <option value={i}>震度{intensityLabel(i)}以上</option>
          {/each}
          <option value="off">知らせない</option>
        </select>
      </label>
      <fieldset class="home" data-testid="home">
        <legend>住んでいる地域 (通知に使う)</legend>
        <p class="small muted">
          タブを閉じていても通知を送るため、サーバーに市町村だけを覚えさせます。地震と気象の両方に使います。
        </p>
        <div class="home-pick">
          <label>
            都道府県
            <select
              bind:value={
                () => pref,
                (v) => {
                  pref = v;
                  setHome("");
                }
              }
            >
              <option value="">選ばない</option>
              {#each prefGroups as g (g.cities[0]?.code)}
                <option value={g.cities[0]?.code.slice(0, 2)}>{g.pref}</option>
              {/each}
            </select>
          </label>
          <label>
            市町村
            <select
              bind:value={() => prefs.home?.code ?? "", setHome}
              disabled={pref === ""}
              data-testid="home-city"
            >
              <option value="">選ばない</option>
              {#each prefCities as c (c.code)}
                <option value={c.code}>{c.name}</option>
              {/each}
            </select>
          </label>
        </div>
        <div class="cluster">
          <button
            type="button"
            class="secondary"
            onclick={locate}
            disabled={locating || Object.keys(cities).length === 0}
            data-testid="home-locate"
            >{locating ? "位置を取っています…" : "現在地から選ぶ"}</button
          >
        </div>
        {#if prefs.home}
          <p class="small muted">
            {prefs.home.name}{prefs.home.quake
              ? `・地震は「${prefs.home.quake.name}」の震度で見ます`
              : ""}
          </p>
        {/if}
      </fieldset>
      <label>
        住んでいる地域の震度
        <select bind:value={prefs.areaMinInt} disabled={!prefs.home?.quake}>
          {#each INTENSITIES as i (i)}
            <option value={i}>震度{intensityLabel(i)}以上</option>
          {/each}
        </select>
      </label>
      <label>
        住んでいる地域の気象
        <select
          bind:value={prefs.weather}
          disabled={!prefs.home && alerter.settings.here === false}
          data-testid="prefs-weather"
        >
          <option value="warning">警報以上</option>
          <option value="all">注意報も</option>
          <option value="off">知らせない</option>
        </select>
      </label>
      <p class="small muted">
        警報以上には、危険警報・特別警報と、記録的短時間大雨情報・竜巻注意情報も入ります。開いているときは、現在地の気象にも同じ条件を使います。
      </p>
      <label>
        <input
          type="checkbox"
          role="switch"
          bind:checked={prefs.weatherSpecial}
        />
        気象の特別警報は、どの地域に出ても知らせる
      </label>
      <label>
        津波
        <select bind:value={prefs.tsunami}>
          <option value="watch">津波注意報以上</option>
          <option value="warning">津波警報以上</option>
          <option value="major">大津波警報だけ</option>
          <option value="off">知らせない</option>
        </select>
      </label>
      <label>
        火山
        <select bind:value={prefs.volcano} data-testid="prefs-volcano">
          <option value="warning">噴火速報と噴火警報 (レベル 4・5)</option>
          <option value="all">火口周辺警報 (レベル 2・3) も</option>
          <option value="off">知らせない</option>
        </select>
      </label>
      <label>
        <input type="checkbox" role="switch" bind:checked={prefs.advisory} />
        南海トラフ地震臨時情報・後発地震注意情報
      </label>
      {#if prefsMessage}
        <p class="small" role="status" data-testid="prefs-status">
          {prefsMessage}
        </p>
      {/if}
    </div>

    <h2 class="section-head">開いているとき</h2>
    <p class="small muted">
      sonae を開いている間に条件に合う情報を受けたら、OS
      の通知と、短い音と読み上げで知らせます。OS
      の通知は、通知を許可していれば画面を押す前でも OS
      の通知音で鳴ります。音と読み上げは、ふつうは画面を一度押すまでブラウザが止めます。sonae
      をアプリとして入れる (Chrome・Edge) か、サイトの設定で自動再生を許す
      (Firefox・Safari・Edge) と、開いただけで鳴らせることがあります。
    </p>
    {#if alerter.alerting && typeof navigator !== "undefined" && isDesktopEdge(navigator.userAgent)}
      <p class="small muted" data-testid="edge-sleep">{EDGE_SLEEP_HINT}</p>
    {/if}
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={alerter.notifying}
        disabled={alerter.permission === "denied" ||
          alerter.permission === "unsupported"}
        onchange={(e) => void setNotify(e.currentTarget)}
        data-testid="alert-notify"
      />
      OS の通知を出す
    </label>
    {#if alerter.permission === "unsupported"}
      <p class="small muted">このブラウザは通知に対応していません。</p>
    {:else if alerter.permission === "denied" && !notifyMessage}
      <p class="small muted">
        {permissionDeniedText(
          typeof navigator === "undefined" ? "" : navigator.userAgent,
        )}
      </p>
    {:else if alerter.permission === "default"}
      <p class="small muted">オンにすると、通知の許可を聞きます。</p>
    {:else if alerter.notifying && alerter.settings.sound}
      <p class="small muted">
        音を鳴らせたときは、通知を音なしで出します (2 つの音を重ねない)。
      </p>
    {/if}
    {#if notifyMessage}
      <p class="small" role="status">{notifyMessage}</p>
    {/if}
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={alerter.settings.sound}
        onchange={(e) => setSound(e.currentTarget.checked)}
        data-testid="alert-sound"
      />
      音を鳴らす
    </label>
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={alerter.settings.speech}
        disabled={!alerter.canSpeak}
        onchange={(e) => setSpeech(e.currentTarget.checked)}
        data-testid="alert-speech"
      />
      読み上げる{alerter.canSpeak
        ? ""
        : " (このブラウザは読み上げに対応していません)"}
    </label>
    {#if alerter.settings.speech && alerter.voicevox && alerter.speech}
      <label>
        声
        <select
          value={alerter.voiceId}
          disabled={voiceSaving}
          onchange={(e) => void setVoice(e.currentTarget)}
          aria-describedby="voice-note"
          data-testid="alert-voice"
        >
          {#each alerter.speech.voices as v (v.id)}
            <option value={v.id}>{voiceLabel(v)}</option>
          {/each}
        </select>
      </label>
      <p class="small" id="voice-note">
        声はこの家の全部の端末で同じになります
        (サーバーに保存します)。読み上げのオン/オフは端末ごとです。
      </p>
      {#if voiceMessage}
        <p class="small" role="status" data-testid="voice-status">
          {voiceMessage}
        </p>
      {/if}
      <div class="cluster">
        <button
          type="button"
          class="secondary"
          disabled={voiceSaving}
          onclick={() => alerter.previewVoice()}>試しに聞く</button
        >
      </div>
    {/if}
    {#if alerter.settings.sound || alerter.settings.speech}
      <div class="cluster">
        <button
          type="button"
          class="secondary"
          onclick={() => alerter.preview()}>試しに鳴らす</button
        >
      </div>
    {/if}
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={alerter.settings.outage !== false}
        onchange={(e) =>
          alerter.setSettings({
            ...alerter.settings,
            outage: e.currentTarget.checked,
          })}
        data-testid="alert-outage"
      />
      受信が切れたら知らせる
    </label>
    <p class="small muted">
      画面への配信が 30 秒続けて切れたら、上でオンにしたもの
      (通知・音・読み上げ)
      で知らせます。戻ったら短く知らせます。切れている間も、自分でつなぎ直します。
    </p>
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={alerter.settings.here !== false}
        onchange={(e) =>
          alerter.setSettings({
            ...alerter.settings,
            here: e.currentTarget.checked,
          })}
        data-testid="alert-here"
      />
      現在地の気象も知らせる
    </label>
    <p class="small muted">
      地図で現在地を出している間、いる市町村の気象警報・注意報も、上の「住んでいる地域の気象」と同じ条件で知らせます。位置はこの端末の中で市町村にするだけで、サーバーに送りません。
    </p>
    {#if alerter.settings.here !== false}
      <p class="small muted" data-testid="alert-here-city">
        {alerter.here
          ? `いまは${alerter.here.name}にいます。`
          : "地図の現在地がオフか、まだ取れていません。住んでいる地域だけで知らせます。"}
      </p>
    {/if}

    <h2 class="section-head">訓練・試験</h2>
    <label>
      <input
        type="checkbox"
        role="switch"
        checked={training}
        onchange={() => goto(trainingHref, { replace: true, reset: false })}
        data-testid="show-training"
      />
      緊急地震速報の訓練・試験も一覧に出す
    </label>
    <p class="small muted">
      一覧と地図に出すだけで、音・読み上げ・Web Push では知らせません。
    </p>

    <h2 class="section-head">Web Push (タブを閉じていても届く)</h2>
    {#if !info}
      <p class="small muted">読んでいます…</p>
    {:else if !info.enabled}
      <p class="small">
        サーバーに VAPID の鍵が入っていないので、Web Push は切ってあります。
      </p>
    {:else if block}
      <!-- 黙って押せないままにしない。何ができないかと、代わりの道を言う -->
      <p class="small" role="status" data-testid="push-unsupported">
        {pushBlockText(block, navigator.userAgent)}
      </p>
    {:else}
      <p class="small muted">
        {registered
          ? "このブラウザは登録済みです。上の条件を変えると、Web Push にもそのまま使います。"
          : "登録すると、上の条件でこのブラウザに通知を送ります。"}
      </p>
      <div class="cluster">
        {#if registered}
          <button type="button" class="secondary" onclick={test} disabled={busy}
            >試しに送る</button
          >
          <button
            type="button"
            class="secondary"
            onclick={() => remove(endpoint)}
            disabled={busy}>解除</button
          >
        {:else}
          <button type="button" onclick={register} disabled={busy}
            >このブラウザで受ける</button
          >
        {/if}
      </div>
      {#if others.length > 0}
        <details>
          <summary class="small">ほかのブラウザ ({others.length})</summary>
          <ul class="small">
            {#each others as o (o.endpoint)}
              <li>
                {o.label || "名前なし"} ({new Date(
                  o.createdAt,
                ).toLocaleDateString("ja-JP")})
                <button
                  type="button"
                  class="secondary"
                  onclick={() => remove(o.endpoint)}
                  disabled={busy}>解除</button
                >
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
    {#if message}
      <p class="small" role="status">{message}</p>
    {/if}
    <!-- 通知が出せないときに、ブラウザが答えている状態をそのまま見せる (設定の画面と食い違うときの手がかり) -->
    <details ontoggle={(e) => e.currentTarget.open && void readDiag()}>
      <summary class="small">ブラウザの通知の状態 (うまくいかないとき)</summary>
      <dl class="diag tiny" data-testid="notify-diag">
        {#each diag as [k, v] (k)}
          <dt>{k}</dt>
          <dd>{v}</dd>
        {/each}
      </dl>
    </details>
    <div class="modal-foot">
      <button type="button" class="secondary" onclick={() => dialog?.close()}
        >閉じる</button
      >
    </div>
  </article>
</dialog>

<style>
  .diag {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--so-space-1) var(--so-space-3);
    margin: var(--so-space-2) 0 0;
    overflow-wrap: anywhere;
  }
  .diag dt,
  .diag dd {
    margin: 0;
  }
  .home {
    margin: 0;
    padding: 0;
    border: 0;
  }
  .home legend {
    padding: 0;
    font-weight: var(--so-weight-bold);
  }
  .home-pick {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--so-space-2);
  }
  .section-head {
    margin: var(--so-space-3) 0 0;
    font-size: var(--so-text-base);
  }
</style>
