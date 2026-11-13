<script lang="ts">
  import "@anyblades/blades/components/accordion";

  import ExternalLink from "~icons/lucide/external-link";

  import {
    depthText,
    jst,
    jstFull,
    magnitudeText,
    quakeName,
    SOURCE_LABEL,
    STATUS_LABEL,
  } from "#lib/format.ts";
  import {
    type AreaIntensity,
    INTENSITIES,
    intensityRank,
    LG_CLASSES,
    lgWords,
    type LongPeriod,
    type ObservedIntensity,
    type Quake,
    type StationIntensity,
    UNRECEIVED,
  } from "#lib/model.ts";

  import Icon from "../Icon.svelte";
  import Intensity from "../Intensity.svelte";
  import LgClass from "../LgClass.svelte";

  /**
   * 地震の詳しい内容。節は見出しと余白で分け、囲まない
   */
  let { q, lp }: { q: Quake; lp?: LongPeriod | null } = $props();

  /** 震度の大きい順に、地域 (または観測点) の名前を束ねる */
  function byIntensity<T extends AreaIntensity | StationIntensity>(items: T[]) {
    const order: ObservedIntensity[] = [...INTENSITIES].reverse();
    order.splice(order.indexOf("5-"), 0, UNRECEIVED);
    return order
      .map((int) => ({ int, items: items.filter((x) => x.int === int) }))
      .filter((g) => g.items.length > 0)
      .sort((a, b) => intensityRank(b.int) - intensityRank(a.int));
  }
  const areas = $derived(byIntensity(q.areas));
  const stations = $derived(byIntensity(q.stations));

  /** 長周期地震動階級の大きい順 (階級 1 以上だけ) に、地域・観測点を束ねる */
  function byLg<T extends { lg: string }>(items: T[]) {
    return [...LG_CLASSES]
      .reverse()
      .filter((c) => c !== "0")
      .map((lg) => ({ lg, items: items.filter((x) => x.lg === lg) }))
      .filter((g) => g.items.length > 0);
  }
  const lgAreas = $derived(lp ? byLg(lp.areas) : []);
  const lgStations = $derived(lp ? byLg(lp.stations) : []);

  const KIND: Record<string, string> = {
    scale: "震度速報",
    hypocenter: "震源に関する情報",
    detail: "震源・震度に関する情報",
    update: "震源要素更新のお知らせ",
    foreign: "遠地地震に関する情報",
    other: "その他の情報",
  };
  /** 事実は控えた字を「・」でつなぐ (バッジにしない) */
  const facts = $derived(
    [
      `${jstFull(q.originTime)} 頃 発生`,
      magnitudeText(q),
      `深さ ${depthText(q.hypocenter)}`,
      q.foreign ? "遠地地震" : "",
      STATUS_LABEL[q.status],
    ].filter(Boolean),
  );
</script>

<div class="detail stack">
  <header class="head">
    <Intensity int={q.maxInt} size="lg" />
    <div class="grow">
      <h1 id="detail-title">{quakeName(q)}</h1>
      <p class="small muted">{facts.join("・")}</p>
      {#if q.cancelled || q.provisional}
        <p class="tags">
          {#if q.cancelled}<span class="tag error">取消</span>{/if}
          {#if q.provisional}<span class="tag info"
              >速報 (気象庁の XML はまだ)</span
            >{/if}
        </p>
      {/if}
    </div>
  </header>

  {#each q.comments as c (c)}
    <p class="small">{c}</p>
  {/each}

  {#if areas.length > 0}
    <section>
      <h2>各地域の震度</h2>
      <dl class="ints">
        {#each areas as g (g.int)}
          <dt><Intensity int={g.int} size="sm" /></dt>
          <dd class="small">{g.items.map((a) => a.name).join("、")}</dd>
        {/each}
      </dl>
    </section>
  {/if}

  {#if lp}
    <!-- 長周期地震動に関する観測情報 (VXSE62)。震度とは別の尺度で、高層ビルの高い階の揺れ -->
    <section data-testid="long-period">
      <h2>長周期地震動</h2>
      <p class="small muted">
        {lp.maxLg === "0"
          ? "階級 1 以上の観測はありません"
          : `最大 長周期地震動階級${lp.maxLg} (${lgWords(lp.maxLg)})`}・{jst(
          lp.reportedAt,
        )} 発表{lp.serial ? `・第 ${lp.serial} 報` : ""}
      </p>
      {#if lp.cancelled}
        <p class="tags"><span class="tag error">取消</span></p>
      {/if}
      {#if lp.headline}<p class="small">{lp.headline}</p>{/if}
      {#if lgAreas.length > 0}
        <dl class="ints">
          {#each lgAreas as g (g.lg)}
            <dt><LgClass lg={g.lg} size="sm" /></dt>
            <dd class="small">{g.items.map((a) => a.name).join("、")}</dd>
          {/each}
        </dl>
      {/if}
      {#if lgStations.length > 0}
        <details>
          <summary>観測点の長周期地震動階級 ({lp.stations.length} 点)</summary>
          <dl class="ints">
            {#each lgStations as g (g.lg)}
              <dt><LgClass lg={g.lg} size="sm" /></dt>
              <dd class="small">
                {g.items
                  .map((s) =>
                    s.sva === undefined ? s.name : `${s.name} (${s.sva} cm/s)`,
                  )
                  .join("、")}
              </dd>
            {/each}
          </dl>
          <p class="tiny muted">
            括弧は絶対速度応答スペクトルの最大値 (周期 1.6〜7.8 秒)
          </p>
        </details>
      {/if}
      {#if lp.url}
        <p class="small lp-link">
          <a class="ext" href={lp.url} target="_blank" rel="noopener noreferrer"
            >気象庁の観測情報のページ (波形・スペクトル)<Icon
              icon={ExternalLink}
              size={0.875}
            /></a
          >
        </p>
      {/if}
    </section>
  {/if}

  {#if stations.length > 0}
    <details>
      <summary>観測点の震度 ({q.stations.length} 点)</summary>
      <dl class="ints">
        {#each stations as g (g.int)}
          <dt><Intensity int={g.int} size="sm" /></dt>
          <dd class="small">{g.items.map((s) => s.name).join("、")}</dd>
        {/each}
      </dl>
    </details>
  {/if}

  <section>
    <h2>発表された情報</h2>
    <ol class="reports small">
      {#each q.reports.toReversed() as r (`${r.source}-${r.code}-${r.reportedAt}-${r.infoType}`)}
        <li class:gone={r.cancelled}>
          {jst(r.reportedAt)}・{KIND[r.kind] ?? r.kind}{r.infoType === "発表"
            ? ""
            : ` (${r.infoType})`}
          <span class="muted">・{SOURCE_LABEL[r.source]}</span>
          {#if r.cancelled}<span class="tag">取消済み</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
</div>

<style>
  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--so-space-3);
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--so-space-1);
    margin-top: var(--so-space-1);
  }
  .ints {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: var(--so-space-2) var(--so-space-3);
    margin: var(--so-space-2) 0 0;
  }
  .ints dt,
  .ints dd {
    margin: 0;
  }
  details {
    margin: 0;
    padding: 0;
    border: 0;
  }
  summary {
    font-weight: var(--so-weight-bold);
  }
  .reports {
    margin: var(--so-space-2) 0 0;
    padding-left: var(--so-space-5);
  }
  .lp-link {
    margin-top: var(--so-space-2);
  }
  .ext {
    display: inline-flex;
    align-items: center;
    gap: var(--so-space-1);
  }
  .gone {
    color: var(--so-muted);
    text-decoration: line-through;
  }
</style>
