<script lang="ts">
  import { depthText, jstClock } from "#lib/format.ts";
  import type { Eew } from "#lib/model.ts";
  import { EEW_NOTICE } from "#lib/notice.ts";

  /**
   * 緊急地震速報の帯。警報は「強い揺れに警戒」と対象の地域、予報は震源と M だけ。
   * **予想震度は出さない** (docs/design.md の 5 章。モデルにも入っていない)。
   */
  let { eew }: { eew: Eew } = $props();
  const kind = $derived(
    eew.cancelled
      ? "cancelled"
      : eew.kind === "warning"
        ? "warning"
        : "forecast",
  );
</script>

<section class="eew {kind}" role="alert" aria-live="assertive">
  <div class="page inner">
    <p class="title">
      {#if eew.cancelled}
        緊急地震速報は取り消されました
      {:else if eew.kind === "warning"}
        緊急地震速報 (警報) 強い揺れに警戒
      {:else}
        緊急地震速報 (予報)
      {/if}
      {#if eew.status !== "normal"}
        <span class="tag">{eew.status === "training" ? "訓練" : "試験"}</span>
      {/if}
    </p>
    {#if !eew.cancelled}
      {#if eew.kind === "warning" && eew.warnAreas.length > 0}
        <p class="areas">
          <span class="label">対象の地域</span>
          {eew.warnAreas.join("・")}
        </p>
      {/if}
      <p class="small meta">
        {#if eew.hypocenter}
          震源 {eew.hypocenter.name}・深さ {depthText(eew.hypocenter)}
        {/if}
        {#if eew.magnitude !== undefined}
          ・M{eew.magnitude.toFixed(1)}
        {/if}
        {#if eew.assumed}
          <span class="tag">仮定震源 (震源と M は目安)</span>
        {/if}
      </p>
    {/if}
    <p class="tiny meta">
      第 {eew.serial} 報{eew.final ? " (最終報)" : ""}・{jstClock(eew.issuedAt)} 発表・{eew.sources.join(
        " / ",
      )}
    </p>
    <p class="tiny meta">{EEW_NOTICE}</p>
  </div>
</section>

<style>
  .eew {
    border-bottom: 1px solid rgb(0 0 0 / 0.2);
    /* 出るときに一度だけ、上から滑り込む (transform と opacity だけ) */
    animation: enter 0.25s ease-out both;
  }
  .inner {
    padding-block: 0.75rem;
  }
  .warning {
    background: var(--so-rec);
    color: #fff;
  }
  .forecast {
    background: #f5c518;
    color: #1a1300;
  }
  .cancelled {
    background: var(--so-subtle);
    color: var(--so-fg);
  }
  .title {
    font-size: 1.25rem;
    font-weight: 700;
  }
  /* 警報は、決めた回数だけ脈打って止まる (常時は回さない) */
  .warning .title {
    animation: pulse 0.9s ease-in-out 3;
  }
  .areas {
    font-size: 1.05rem;
    font-weight: 700;
  }
  .label {
    margin-right: 0.5rem;
    font-size: 0.8rem;
    font-weight: 400;
    opacity: 0.85;
  }
  .meta {
    opacity: 0.9;
  }
  p,
  .tag {
    color: inherit;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(-0.5rem);
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
      transform: scale(1.01);
    }
  }
</style>
