<script lang="ts">
  import { jst, jstFull, STATUS_LABEL, volcanoKindText } from "#lib/format.ts";
  import { type Volcano, VOLCANO_LABEL } from "#lib/model.ts";
  import { BOSAI_NOTE } from "#lib/notice.ts";

  import VolcanoLevel from "../VolcanoLevel.svelte";

  /**
   * 火山の情報 (噴火警報・予報、解説情報、観測報、降灰予報、噴火速報、推定噴煙流向報) の詳しい内容。
   * 電文の見出し・活動の状況・防災上の警戒事項・降灰の範囲を文のまま出す。気象庁の文を言い換えない
   * (警報を自分で作らない。docs/design.md の 5 章)
   */
  let { v }: { v: Volcano } = $props();

  const flash = $derived(v.code === "VFVO56");
  /** 噴火警報・予報と噴火速報のほかは、火山の行に段を出さない (種類は警報ではない) */
  const leveled = $derived(v.code === "VFVO50" || v.code === "VFVO51" || flash);
  /** 事実は控えた字を「・」でつなぐ (バッジにしない) */
  const facts = $derived(
    [
      flash || v.code === "VFVO50" ? "" : VOLCANO_LABEL[v.code],
      `${jstFull(v.reportedAt)} 発表`,
      v.eventTime
        ? `${flash || v.code === "VFVO52" ? "噴火" : "発生"} ${jst(v.eventTime)} 頃`
        : "",
      v.validUntil ? `${jst(v.validUntil)} まで有効` : "",
      STATUS_LABEL[v.status],
    ].filter(Boolean),
  );
  /** 噴煙の高さと流れる向き (電文の説明の文のまま。「火口上2200m (海抜10700FT)・流向 直上」) */
  const plume = $derived(
    [
      [v.plume?.height, v.plume?.seaLevel ? `(${v.plume.seaLevel})` : ""]
        .filter(Boolean)
        .join(" "),
      v.plume?.direction ? `流向 ${v.plume.direction}` : "",
    ]
      .filter(Boolean)
      .join("・"),
  );
</script>

<div class="detail stack">
  <header>
    <h1 id="detail-title">{flash ? "噴火速報" : v.title}</h1>
    <p class="small muted">{facts.join("・")}</p>
    {#if v.cancelled}
      <p class="tags"><span class="tag error">取消</span></p>
    {/if}
  </header>

  {#if v.source === "jma-bosai"}
    <!-- 地震火山 XML が取れない間に、気象庁ホームページの JSON (予備) から受けた報 (docs/design.md の 2.1) -->
    <p class="small">{BOSAI_NOTE}</p>
  {/if}

  {#if v.headline}
    <p class="small pre-line">{v.headline}</p>
  {/if}

  {#if v.volcanoes.length > 0}
    <section>
      <h2>火山</h2>
      <ul class="plain small stack">
        {#each v.volcanoes as a (a.code)}
          <li class="volcano">
            {#if leveled}
              <VolcanoLevel
                level={flash ? 5 : a.level}
                label={volcanoKindText(a.kind)}
              />
            {/if}
            <span>
              <span class="bold">{a.name}</span>
              {#if !leveled && a.kind}
                <span class="muted">{volcanoKindText(a.kind)}</span>
              {/if}
              {#if leveled && (a.condition || a.lastKind)}
                <span class="muted"
                  >{[
                    a.condition,
                    a.lastKind ? `前は ${volcanoKindText(a.lastKind)}` : "",
                  ]
                    .filter(Boolean)
                    .join("・")}</span
                >
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if v.ash && v.ash.length > 0}
    <section>
      <h2>降灰の範囲</h2>
      <dl class="small facts">
        {#each v.ash as a (a.name)}
          <dt>{a.name}</dt>
          <dd>{a.cities.join("、") || "なし"}</dd>
        {/each}
      </dl>
    </section>
  {:else if v.warning || v.cities.length > 0}
    <section>
      <h2>対象の市町村</h2>
      {#if v.warning}
        <p class="small">
          {v.warning.name}{v.warning.condition
            ? ` (${v.warning.condition})`
            : ""}
        </p>
      {/if}
      {#if v.cities.length > 0}
        <p class="small muted">{v.cities.join("、")}</p>
      {/if}
    </section>
  {/if}

  {#if plume || v.observation}
    <section>
      <h2>噴煙と観測</h2>
      {#if plume}<p class="small">噴煙 {plume}</p>{/if}
      {#if v.observation}
        <p class="small pre-line muted">{v.observation}</p>
      {/if}
    </section>
  {/if}

  {#if v.activity}
    <section>
      <h2>火山活動の状況</h2>
      <p class="small pre-line">{v.activity}</p>
    </section>
  {/if}
  {#if v.prevention}
    <section>
      <h2>防災上の警戒事項等</h2>
      <p class="small pre-line">{v.prevention}</p>
    </section>
  {/if}
  {#if v.nextAdvisory}
    <p class="small muted pre-line">{v.nextAdvisory.trim()}</p>
  {/if}
  {#if v.appendix}
    <section>
      <h2>参考</h2>
      <p class="small pre-line muted">{v.appendix}</p>
    </section>
  {/if}
</div>

<style>
  .volcano {
    display: flex;
    align-items: baseline;
    gap: var(--so-space-2);
  }
  .volcano > span:last-child {
    display: flex;
    flex-direction: column;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--so-space-1) var(--so-space-3);
    margin: var(--so-space-2) 0 0;
  }
  .facts dd {
    margin: 0;
  }
</style>
