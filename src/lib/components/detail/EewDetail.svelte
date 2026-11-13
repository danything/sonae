<script lang="ts">
  import { depthText, jstFull } from "#lib/format.ts";
  import type { Eew } from "#lib/model.ts";
  import { EEW_NOTICE } from "#lib/notice.ts";

  /**
   * 緊急地震速報の詳しい内容 (前の `/eew` の表の 1 行)。**予想震度は出さない** (docs/design.md の 5 章)
   */
  let { e }: { e: Eew } = $props();
  const title = $derived(
    e.cancelled
      ? "緊急地震速報 (取消)"
      : e.kind === "warning"
        ? "緊急地震速報 (警報)"
        : "緊急地震速報 (予報)",
  );
  const facts = $derived(
    [
      `${jstFull(e.issuedAt)} 発表`,
      `第 ${e.serial} 報${e.final ? " (最終報)" : ""}`,
      e.status === "training" ? "訓練" : e.status === "test" ? "試験" : "",
      e.sources
        .map((s) => (s === "wolfx" ? "Wolfx Project" : "P2P地震情報"))
        .join("、"),
    ].filter(Boolean),
  );
</script>

<div class="detail stack">
  <header>
    <h1 id="detail-title">{title}</h1>
    <p class="small muted">{facts.join("・")}</p>
  </header>
  <dl class="facts">
    <dt>震源</dt>
    <dd>
      {e.hypocenter?.name ?? "—"}{e.assumed
        ? " (仮定震源。震源と M は目安)"
        : ""}
    </dd>
    <dt>M</dt>
    <dd>{e.magnitude !== undefined ? `M${e.magnitude.toFixed(1)}` : "—"}</dd>
    <dt>深さ</dt>
    <dd>{depthText(e.hypocenter)}</dd>
    <dt>警報の地域</dt>
    <dd>{e.warnAreas.length > 0 ? e.warnAreas.join("、") : "—"}</dd>
  </dl>
  <p class="small muted">{EEW_NOTICE}</p>
</div>

<style>
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
</style>
