<script lang="ts">
  /**
   * 通知の条件と、開いているときの音・読み上げと、Web Push の登録 (docs/design.md の 2.4)。
   * ヘッダーのナビ (スマホの形は「その他」) の「通知」から開くダイアログ 1 つに閉じる。
   * 開け閉めは `open` で持つ (閉じるのは左下の「閉じる」・幕・Esc)。
   * 条件はブラウザごとに 1 つで、音・読み上げのために端末 (localStorage) に、Web Push のためにサーバー (購読) に持つ。
   * サーバーに VAPID の鍵が無いときは、Web Push の節にそう出すだけ (条件と音・読み上げは使える)。
   */
  import "@anyblades/blades/components/modal";

  import { alerter } from "#lib/alerter.svelte.ts";
  import { INTENSITIES, intensityLabel } from "#lib/model.ts";
  import {
    base64UrlToBytes,
    DEFAULT_PREFS,
    normalizePrefs,
    type PushPrefs,
  } from "#lib/push.ts";

  interface Registered {
    endpoint: string;
    label: string;
    prefs: PushPrefs;
    createdAt: number;
  }
  let { open = $bindable(false) }: { open?: boolean } = $props();

  type Info =
    | { enabled: false }
    | { enabled: true; publicKey: string; subscriptions: Registered[] };

  let dialog = $state<HTMLDialogElement>();
  let info = $state<Info>();
  let supported = $state(true);
  let endpoint = $state<string>();
  let prefs = $state<PushPrefs>({ ...DEFAULT_PREFS });
  let areas = $state<{ code: string; name: string }[]>([]);
  let busy = $state(false);
  let message = $state("");

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
    message = "";
    prefs = normalizePrefs(alerter.prefs);
    if (areas.length === 0) void loadAreas();
    supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    const res = await fetch("/api/push");
    if (!res.ok) {
      message = `Web Push の登録を読めませんでした (${res.status})`;
      return;
    }
    info = (await res.json()) as Info;
    if (!info.enabled || !supported) return;
    const sub = await (await registration()).pushManager.getSubscription();
    endpoint = sub?.endpoint;
    const mine = info.subscriptions.find((s) => s.endpoint === endpoint);
    if (mine) prefs = normalizePrefs(mine.prefs);
  }

  /** 条件を端末に覚え、Web Push に登録してあればサーバーにも送る */
  async function savePrefs(): Promise<void> {
    alerter.setPrefs(prefs);
    if (!registered) {
      message = "保存しました";
      return;
    }
    await save();
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

  /** 現在地の候補 (地震情報の細分区域)。地図と同じファイルから名前だけ取る */
  async function loadAreas(): Promise<void> {
    try {
      const res = await fetch("/areas/quake-areas.geojson");
      const fc = (await res.json()) as {
        features: { properties: { code: string; name: string } }[];
      };
      const byCode = new Map(
        fc.features.map((f) => [f.properties.code, f.properties.name]),
      );
      areas = [...byCode]
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => Number(a.code) - Number(b.code));
    } catch {
      // 候補が出ないだけ
    }
  }

  // 開いたら、そのたびに購読と条件を読み直す
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      load().catch((err: unknown) => (message = `読めませんでした: ${err}`));
    } else if (!open && dialog.open) dialog.close();
  });

  /** 公開鍵が替わっていたら、購読を作り直す (古い鍵の購読には送れない) */
  async function subscribe(key: string): Promise<PushSubscription> {
    const pm = (await registration()).pushManager;
    const want = base64UrlToBytes(key);
    const cur = await pm.getSubscription();
    if (cur) {
      const have = cur.options.applicationServerKey;
      const same =
        have !== null &&
        new Uint8Array(have).length === want.length &&
        new Uint8Array(have).every((b, i) => b === want[i]);
      if (same) return cur;
      await cur.unsubscribe();
    }
    return pm.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  }

  async function save(): Promise<void> {
    if (!info?.enabled) return;
    busy = true;
    message = "";
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        message =
          "通知が許可されていません。ブラウザのサイトの設定で許可してください。";
        return;
      }
      const sub = await subscribe(info.publicKey);
      alerter.setPrefs(prefs);
      const res = await fetch("/api/push", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          prefs,
          label: navigator.userAgent,
        }),
      });
      message = res.ok
        ? "保存しました"
        : `保存できませんでした (${res.status}): ${await res.text()}`;
      await load();
    } catch (err) {
      message = `登録できませんでした: ${err}`;
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

  function setArea(code: string): void {
    const a = areas.find((x) => x.code === code);
    prefs.area = a ? { code: a.code, name: a.name } : null;
  }
</script>

<dialog
  bind:this={dialog}
  closedby="any"
  aria-labelledby="push-title"
  onclose={() => (open = false)}
>
  <article class="modal-box stack">
    <h1 id="push-title">通知</h1>
    <p class="small muted">
      条件はこのブラウザごとに覚え、開いているときの音・読み上げと Web Push
      の両方に使います。訓練・試験は知らせません。
    </p>
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
    <label>
      現在地 (地震情報の地域)
      <select bind:value={() => prefs.area?.code ?? "", setArea}>
        <option value="">選ばない</option>
        {#each areas as a (a.code)}
          <option value={a.code}>{a.name}</option>
        {/each}
      </select>
    </label>
    <label>
      現在地の震度
      <select bind:value={prefs.areaMinInt} disabled={!prefs.area}>
        {#each INTENSITIES as i (i)}
          <option value={i}>震度{intensityLabel(i)}以上</option>
        {/each}
      </select>
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
    <div class="cluster">
      <button
        type="button"
        onclick={savePrefs}
        disabled={busy}
        data-testid="prefs-save">条件を保存</button
      >
    </div>

    <h2 class="section-head">開いているとき</h2>
    <p class="small muted">
      sonae
      を開いている間に条件に合う情報を受けたら、短い音と見出しの読み上げで知らせます。ブラウザは、画面を一度押すまで音を出させません。
    </p>
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
        disabled={!alerter.speechSupported}
        onchange={(e) => setSpeech(e.currentTarget.checked)}
        data-testid="alert-speech"
      />
      見出しを読み上げる{alerter.speechSupported
        ? ""
        : " (このブラウザは読み上げに対応していません)"}
    </label>
    {#if alerter.settings.sound || alerter.settings.speech}
      <div class="cluster">
        <button
          type="button"
          class="secondary"
          onclick={() => alerter.preview()}>試しに鳴らす</button
        >
      </div>
    {/if}

    <h2 class="section-head">Web Push (タブを閉じていても届く)</h2>
    {#if !info}
      <p class="small muted">読んでいます…</p>
    {:else if !info.enabled}
      <p class="small">
        サーバーに VAPID の鍵が入っていないので、Web Push は切ってあります。
      </p>
    {:else if !supported}
      <p class="small">
        このブラウザは Web Push に対応していません。iPhone・iPad
        は、共有ボタンから「ホーム画面に追加」した sonae (iOS 16.4 以降)
        で開いてください。
      </p>
    {:else}
      <p class="small muted">
        {registered
          ? "このブラウザは登録済みです。条件を保存すると、Web Push にも使います。"
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
          <button type="button" onclick={save} disabled={busy}
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
    <div class="modal-foot">
      <button type="button" class="secondary" onclick={() => dialog?.close()}
        >閉じる</button
      >
    </div>
  </article>
</dialog>

<style>
  .section-head {
    margin: var(--so-space-3) 0 0;
    font-size: var(--so-text-base);
  }
</style>
