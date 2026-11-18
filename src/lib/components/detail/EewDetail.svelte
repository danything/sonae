<script lang="ts">
  import ExternalLink from "~icons/lucide/external-link";

  import Icon from "#lib/components/Icon.svelte";
  import {
    depthText,
    eewSourceLine,
    jstClock,
    jstFull,
    magnitudeText,
    placeName,
    SOURCE_LABEL,
    STATUS_LABEL,
  } from "#lib/format.ts";
  import type { Eew } from "#lib/model.ts";
  import { EEW_NOTICE, KMONI_URL } from "#lib/notice.ts";

  /**
   * 緊急地震速報の詳しい内容。**予想震度は出さない** (docs/design.md の 5 章。モデルにも入っていない)。
   *
   * いま出ているもの (`active`。訓練・試験を除き、最後の報から 3 分の間。`#lib/eew.ts`) は、先頭の箱に出す (docs/ui.md の「自動で開く」)。
   * 警報は状態の赤で塗り「強い揺れに警戒」と対象の地域、予報は震源と M、取消は取り消されたこと。
   * 箱は `role="alert"` で、続報で中身が変わるたびに読み上げソフトにも伝わる。強震モニタへのリンクもここ
   */
  let { e, active = false }: { e: Eew; active?: boolean } = $props();
  const title = $derived(
    e.cancelled
      ? "緊急地震速報 (取消)"
      : e.kind === "warning"
        ? "緊急地震速報 (警報)"
        : "緊急地震速報 (予報)",
  );
  const tone = $derived(
    e.cancelled ? "cancelled" : e.kind === "warning" ? "warning" : "forecast",
  );
  const facts = $derived(
    [
      `${jstFull(e.issuedAt)} 発表`,
      `第 ${e.serial} 報${e.final ? " (最終報)" : ""}`,
      STATUS_LABEL[e.status],
      e.sources.map((s) => SOURCE_LABEL[s]).join("、"),
    ].filter(Boolean),
  );
  const sourceLine = $derived(eewSourceLine(e));
</script>

<div class="detail stack">
  {#if active}
    <section
      class="eew-now {tone}"
      role="alert"
      aria-live="assertive"
      data-testid="eew-now"
    >
      <h1 class="now-title" id="detail-title">
        {#if e.cancelled}
          緊急地震速報は取り消されました
        {:else if e.kind === "warning"}
          緊急地震速報 (警報) 強い揺れに警戒
        {:else}
          緊急地震速報 (予報)
        {/if}
      </h1>
      {#if !e.cancelled}
        {#if e.kind === "warning" && e.warnAreas.length > 0}
          <p class="areas">
            <span class="label">対象の地域</span>
            {e.warnAreas.join("・")}
          </p>
        {/if}
        {#if sourceLine || e.assumed}
          <p class="small">
            {sourceLine}
            {#if e.assumed}
              <span class="tag">仮定震源 (震源と M は目安)</span>
            {/if}
          </p>
        {/if}
      {/if}
      <p class="tiny">
        第 {e.serial} 報{e.final ? " (最終報)" : ""}・{jstClock(e.issuedAt)} 発表・{e.sources
          .map((s) => SOURCE_LABEL[s])
          .join("、")}
      </p>
      {#if !e.cancelled}
        <!-- 揺れの広がりは防災科研の公式の強震モニタで見てもらう (リンクだけ。docs/design.md 1 章) -->
        <p class="small">
          <a
            class="kmoni"
            href={KMONI_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="eew-kmoni"
            >強震モニタを開く<Icon icon={ExternalLink} size={0.875} /></a
          >
        </p>
      {/if}
    </section>
  {:else}
    <header>
      <h1 id="detail-title">{title}</h1>
      <p class="small muted">{facts.join("・")}</p>
    </header>
  {/if}
  <dl class="facts">
    <dt>震源</dt>
    <dd>
      {placeName(e.hypocenter)}{e.assumed ? " (仮定震源。震源と M は目安)" : ""}
    </dd>
    <dt>M</dt>
    <dd>{magnitudeText(e)}</dd>
    <dt>深さ</dt>
    <dd>{depthText(e.hypocenter)}</dd>
    <dt>警報の地域</dt>
    <dd>{e.warnAreas.length > 0 ? e.warnAreas.join("、") : "—"}</dd>
    {#if active}
      <dt>発表</dt>
      <dd>{facts.join("・")}</dd>
    {/if}
  </dl>
  <p class="small muted">{EEW_NOTICE}</p>
</div>

<style>
  /*
   * いま出ている緊急地震速報の箱。警報だけは状態の赤で塗る (docs/design.md の 6.2。どこを見ていても一目で分かるように)。
   * 予報と取消は塗らず、淡い面に注意の色の見出し (ページの中の通知と同じ)
   */
  .eew-now {
    padding: var(--so-space-3) var(--so-space-4);
    border-radius: var(--so-item-radius);
    /* 出るときに一度だけ、上から滑り込む (transform と opacity だけ) */
    animation: enter var(--so-duration-enter) var(--so-ease-spring) both;
  }
  .eew-now p {
    margin: 0 0 var(--so-space-1);
    color: inherit;
  }
  .eew-now p:last-child {
    margin-bottom: 0;
  }
  .eew-now .tag {
    color: inherit;
  }
  .warning {
    background: var(--so-rec);
    color: #fff;
  }
  .forecast,
  .cancelled {
    background: var(--so-subtle);
    color: var(--so-fg);
  }
  .forecast .now-title {
    color: var(--so-warn-text);
  }
  .now-title {
    margin: 0 0 var(--so-space-1);
    color: inherit;
    font-size: var(--so-text-lg);
    font-weight: var(--so-weight-bold);
  }
  /* 警報は、決めた回数だけ脈打って止まる (常時は回さない。動きを減らす設定では止まる) */
  .warning .now-title {
    --so-pulse-opacity: 0.55;
    --so-pulse-scale: 1.01;
    animation: var(--so-pulse);
  }
  .areas {
    font-size: var(--so-text-base);
    font-weight: var(--so-weight-bold);
  }
  .label {
    margin-right: var(--so-space-2);
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight);
    opacity: 0.85;
  }
  .kmoni {
    display: inline-flex;
    align-items: center;
    gap: var(--so-space-1);
    color: inherit;
    font-weight: var(--so-weight-bold);
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--so-space-2) var(--so-space-4);
    margin: 0;
  }
  .facts dt {
    color: var(--so-muted);
    font-size: var(--so-text-sm);
    font-weight: var(--so-weight);
  }
  .facts dd {
    margin: 0;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(-0.5rem);
    }
  }
</style>
