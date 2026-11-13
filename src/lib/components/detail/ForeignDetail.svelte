<script lang="ts">
  import { jst, jstFull, SOURCE_LABEL } from "#lib/format.ts";
  import type { ForeignQuake, ForeignReport } from "#lib/model.ts";

  /**
   * 海外の地震の詳しい内容。まとめた地震のいまの姿と、機関ごとの発表を並べる。
   * 日本への津波は気象庁の情報が正なので、そのことを書く
   */
  let { q }: { q: ForeignQuake } = $props();

  const mag = (r: Pick<ForeignReport, "magnitude" | "magType">) =>
    r.magnitude === undefined
      ? "M 不明"
      : `M${r.magnitude.toFixed(1)}${r.magType ? ` (${r.magType})` : ""}`;
  const depth = (km: number | undefined) =>
    km === undefined ? "深さ 不明" : `深さ 約 ${Math.round(km)} km`;
  const facts = $derived(
    [`${jstFull(q.originTime)} 頃 発生`, mag(q), depth(q.depthKm)].filter(
      Boolean,
    ),
  );
</script>

<div class="detail stack">
  <header>
    <h1 id="detail-title">{q.place || "場所は不明"}</h1>
    <p class="small muted">{facts.join("・")}</p>
    <p class="small muted">
      緯度 {q.lat.toFixed(2)}・経度 {q.lon.toFixed(2)} (日本時間で表示)
    </p>
  </header>

  <p class="small">
    海外の機関が出した地震の情報です。日本への津波のおそれは、気象庁の津波の情報を確かめてください。
  </p>
  {#if q.tsunami}
    <p class="small">
      USGS がこの地震に津波の印を付けています (津波の予報や警報ではありません)。
    </p>
  {/if}

  <section>
    <h2>発表した機関</h2>
    <ul class="plain small stack">
      {#each q.reports as r (`${r.source}:${r.sourceId}`)}
        <li>
          <span class="bold">{SOURCE_LABEL[r.source]}</span>
          <span class="muted"
            >{[
              mag(r),
              depth(r.depthKm),
              r.updatedAt ? `${jst(r.updatedAt)} 更新` : "",
            ]
              .filter(Boolean)
              .join("・")}</span
          >
          <span>{r.place}</span>
          {#if r.url}
            <a href={r.url} target="_blank" rel="noopener noreferrer"
              >機関のページ</a
            >
          {/if}
        </li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .plain {
    margin: var(--so-space-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .plain li {
    display: flex;
    flex-direction: column;
  }
</style>
