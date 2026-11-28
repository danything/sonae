<script lang="ts">
  import {
    SOURCE_LABEL,
    sourceInTrouble,
    sourceStateText,
    transportText,
  } from "#lib/format.ts";
  import type { SourceStatus } from "#lib/model.ts";
  import {
    RELAY_LABEL,
    RELAY_VIA,
    relayInTrouble,
    relayStateText,
  } from "#lib/relay-view.ts";
  import type { RelayStatus } from "#lib/relay.ts";

  /**
   * **受信の状態** (押せない並び)。画面への配信 (SSE) と、情報源ごとの受信。「出典と注意」の窓の「受信の状態」に
   * いつも出し、受信に問題があるときだけ出る注意の印 (広い形はヘッダー、スマホの形は dock の右端) を押してもメニューに出す。
   * ふつうの状態 (受信中) と設定で切ってあるもの (オフ) は控えた字、つながっていないものだけ注意の色の字にする
   * (状態の色は状態だけ)。名前の下に、つなぎ方 (「WebSocket」「SSE」「1 分ごとに取得」) を小さく添える。
   * その後に、地図のタイルなどの中継の源 (docs/design.md の 2.14) を、まだ誰も読んでいないものを除いて並べる。
   * 配信元から取れていないものは、受信の問題と同じく注意の色の字にする
   */
  let {
    connected,
    statuses,
    relay,
  }: {
    connected: boolean;
    statuses: SourceStatus[];
    relay: RelayStatus[];
  } = $props();
</script>

<dl class="side-list status" data-testid="status">
  <div class="side-item static">
    <dt>
      画面への配信
      <span class="via">SSE</span>
    </dt>
    <dd class="side-sub" class:bad={!connected}>
      {connected ? "受信中" : "再接続しています"}
    </dd>
  </div>
  {#each statuses as s (s.id)}
    {@const via = s.state === "off" ? "" : transportText(s.transport)}
    <div class="side-item static" title={s.lastError || undefined}>
      <dt>
        {SOURCE_LABEL[s.id] ?? s.id}
        {#if via}<span class="via">{via}</span>{/if}
      </dt>
      <dd class="side-sub num" class:bad={sourceInTrouble(s)}>
        {sourceStateText(s)}
      </dd>
    </div>
  {:else}
    <div class="side-item static">
      <dt class="muted">受信を開始していません</dt>
    </div>
  {/each}
  {#each relay.filter((r) => r.state !== "idle") as r (r.id)}
    <div class="side-item static" data-testid="relay-status">
      <dt>
        {RELAY_LABEL[r.id] ?? r.id}
        <span class="via">{RELAY_VIA}</span>
      </dt>
      <dd class="side-sub num" class:bad={relayInTrouble(r)}>
        {relayStateText(r)}
      </dd>
    </div>
  {/each}
</dl>

<style>
  .status dt,
  .status dd {
    margin: 0;
    font-weight: var(--so-weight);
  }
  .status dt {
    flex: 1 1 50%;
    min-width: 0;
    padding-block: var(--so-space-1);
  }
  /* 長い状態 (通行止めの災害の名前) は折り返す。名前の列を押しつぶさない */
  .status dd {
    flex: 0 1 auto;
    min-width: 0;
    text-align: end;
  }
  /* つなぎ方。名前の下に控えた小さな字で */
  .status .via {
    display: block;
    color: var(--so-muted);
    font-size: var(--so-text-xs);
  }
  .status .bad {
    color: var(--so-warn-text);
    font-weight: var(--so-weight-bold);
  }
</style>
