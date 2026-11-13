<script lang="ts">
  import { jst } from "#lib/format.ts";
  import type { SourceStatus } from "#lib/model.ts";

  /**
   * **状態** (押せない並び)。画面への配信 (SSE) と、情報源ごとの受信。広い形はサイドバー、スマホの形は dock の「⋯」の先頭に同じものを出す。
   * ふつうの状態 (受信中) は控えた字、つながっていないものだけ注意の色の字にする (状態の色は状態だけ)
   */
  let {
    connected,
    statuses,
  }: { connected: boolean; statuses: SourceStatus[] } = $props();

  const NAMES: Record<string, string> = {
    jma: "気象庁 防災情報 XML",
    p2p: "P2P地震情報",
    wolfx: "Wolfx Project",
  };
  const STATES: Record<string, string> = {
    connecting: "接続中",
    connected: "受信中",
    retrying: "再接続中",
    stopped: "停止",
  };
</script>

<dl class="side-list status" data-testid="status">
  <div class="side-item static">
    <dt>画面への配信</dt>
    <dd class="side-sub" class:bad={!connected}>
      {connected ? "接続中" : "切断"}
    </dd>
  </div>
  {#each statuses as s (s.id)}
    <div
      class="side-item static"
      title={s.lastError ? `${s.lastError}` : undefined}
    >
      <dt>{NAMES[s.id] ?? s.id}</dt>
      <dd class="side-sub num" class:bad={s.state !== "connected"}>
        {STATES[s.state] ?? s.state}{s.lastSeenAt
          ? `・${jst(s.lastSeenAt)}`
          : ""}
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
