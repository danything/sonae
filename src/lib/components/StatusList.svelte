<script lang="ts">
  import {
    SOURCE_LABEL,
    sourceInTrouble,
    sourceStateText,
  } from "#lib/format.ts";
  import type { SourceStatus } from "#lib/model.ts";

  /**
   * **受信の状態** (押せない並び)。画面への配信 (SSE) と、情報源ごとの受信。「出典と注意」の窓の「受信の状態」に
   * いつも出し、受信に問題があるときだけ出る注意の印 (広い形はヘッダー、スマホの形は dock の右端) を押してもメニューに出す。
   * ふつうの状態 (受信中) と設定で切ってあるもの (オフ) は控えた字、つながっていないものだけ注意の色の字にする
   * (状態の色は状態だけ)
   */
  let {
    connected,
    statuses,
  }: { connected: boolean; statuses: SourceStatus[] } = $props();
</script>

<dl class="side-list status" data-testid="status">
  <div class="side-item static">
    <dt>画面への配信</dt>
    <dd class="side-sub" class:bad={!connected}>
      {connected ? "接続中" : "再接続しています"}
    </dd>
  </div>
  {#each statuses as s (s.id)}
    <div
      class="side-item static"
      title={s.lastError ? `${s.lastError}` : undefined}
    >
      <dt>{SOURCE_LABEL[s.id] ?? s.id}</dt>
      <dd class="side-sub num" class:bad={sourceInTrouble(s)}>
        {sourceStateText(s)}
      </dd>
    </div>
  {:else}
    <div class="side-item static">
      <dt class="muted">受信を開始していません</dt>
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
    min-width: 0;
  }
  .status .bad {
    color: var(--so-warn-text);
    font-weight: var(--so-weight-bold);
  }
</style>
