<script lang="ts">
  /**
   * 「通知」の窓の Webhook の節 (docs/design.md の 2.4)。Discord や Slack の Incoming Webhook の URL を足すと、
   * 上の条件に合う報を Web Push と同じ見出しと本文で送る。
   * URL は秘密 (知っていれば誰でも投稿できる) なので、足した後はホストだけを出す (サーバーも URL を返さない)。
   * 窓を開くたびに読み直す。
   */
  import { jst } from "#lib/format.ts";
  import type { PushPrefs } from "#lib/push.ts";
  import {
    addWebhook,
    readWebhooks,
    removeWebhook,
    testWebhook,
  } from "#lib/webhook-client.ts";
  import { statusLabel, type WebhookView } from "#lib/webhook.ts";

  let {
    open,
    prefs,
  }: {
    /** 窓が開いているか (開いたら読み直す) */
    open: boolean;
    /** 足すときに使う「通知」の条件 */
    prefs: PushPrefs;
  } = $props();

  let hooks = $state<WebhookView[]>();
  let url = $state("");
  let busy = $state(false);
  let message = $state("");

  async function load(): Promise<void> {
    try {
      hooks = await readWebhooks();
    } catch (err) {
      message = String(err instanceof Error ? err.message : err);
    }
  }

  $effect(() => {
    if (!open) return;
    message = "";
    void load();
  });

  async function add(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    try {
      const failed = await addWebhook(url.trim(), $state.snapshot(prefs));
      // 足せたら URL を欄から消す (画面に残さない)
      if (!failed) url = "";
      message = failed ?? "追加しました。上の条件で送ります";
      await load();
    } catch (err) {
      message = `追加できませんでした: ${err}`;
    } finally {
      busy = false;
    }
  }

  async function remove(id: number): Promise<void> {
    busy = true;
    try {
      message = (await removeWebhook(id)) ?? "解除しました";
      await load();
    } catch (err) {
      message = `解除できませんでした: ${err}`;
    } finally {
      busy = false;
    }
  }

  async function test(id: number): Promise<void> {
    busy = true;
    try {
      message = await testWebhook(id);
      await load();
    } catch (err) {
      message = `送れませんでした: ${err}`;
    } finally {
      busy = false;
    }
  }
</script>

<h2 class="section-head">Webhook (Discord・Slack など)</h2>
<p class="small muted">
  Discord や Slack の Incoming Webhook の URL を足すと、上の条件に合う情報を Web
  Push と同じ見出しと本文で送ります。条件は、上で最後に変えたものを使います。URL
  を知っていれば誰でも投稿できるので、足した後は送り先のホストだけを出します。
</p>
<form class="stack" onsubmit={add}>
  <label>
    URL
    <input
      type="url"
      bind:value={url}
      required
      autocomplete="off"
      placeholder="https://discord.com/api/webhooks/..."
      data-testid="webhook-url"
    />
  </label>
  <div class="cluster">
    <button
      type="submit"
      class="secondary"
      disabled={busy}
      data-testid="webhook-add">追加</button
    >
  </div>
</form>
{#if hooks && hooks.length > 0}
  <ul class="small hooks" data-testid="webhook-list">
    {#each hooks as h (h.id)}
      <li>
        <span class="host">{h.host}</span>
        <span class="muted"
          >直近の結果: {statusLabel(h.lastStatus)}{h.lastSentAt
            ? ` (${jst(new Date(h.lastSentAt).toISOString())})`
            : ""}</span
        >
        <span class="cluster">
          <button
            type="button"
            class="secondary"
            onclick={() => test(h.id)}
            disabled={busy}>試しに送る</button
          >
          <button
            type="button"
            class="secondary"
            onclick={() => remove(h.id)}
            disabled={busy}>解除</button
          >
        </span>
      </li>
    {/each}
  </ul>
{/if}
{#if message}
  <p class="small" role="status" data-testid="webhook-status">{message}</p>
{/if}

<style>
  .hooks {
    display: flex;
    flex-direction: column;
    gap: var(--so-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hooks li {
    display: flex;
    flex-direction: column;
    gap: var(--so-space-1);
  }
  .host {
    overflow-wrap: anywhere;
  }
</style>
