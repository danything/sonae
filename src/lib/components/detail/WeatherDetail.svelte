<script lang="ts">
  import "@anyblades/blades/content/table";

  import {
    jst,
    jstFull,
    kindText,
    STATUS_LABEL,
    waterLevelText,
    weatherTitle,
  } from "#lib/format.ts";
  import {
    isExpired,
    WEATHER_INFO_LABEL,
    type WeatherInfo,
  } from "#lib/model.ts";

  import WarningLevel from "../WarningLevel.svelte";
  import TyphoonSection from "./TyphoonSection.svelte";

  /**
   * 気象の報 (記録的短時間大雨情報・気象防災速報・竜巻注意情報・指定河川洪水予報・熱中症警戒アラート・台風情報)
   * の詳しい内容。見出しと本文は電文の文のまま出す (言い換えない。docs/design.md の 5 章)
   */
  let { w, now }: { w: WeatherInfo; now: number } = $props();

  const expired = $derived(isExpired(w, now));
  /** 事実は控えた字を「・」でつなぐ (バッジにしない) */
  const facts = $derived(
    [
      `${jstFull(w.reportedAt)} 発表`,
      w.validUntil ? `${jst(w.validUntil)} まで有効` : "",
      STATUS_LABEL[w.status],
    ].filter(Boolean),
  );
  /** 地域は府県予報区・一次細分区域等・市町村等が混ざるので、名前の並びだけ出す (洪水予報は河川) */
  const areas = $derived([...new Set(w.areas.map((a) => a.name))]);
  const t = $derived(w.typhoon);
  const typhoonFacts = $derived(
    t
      ? [
          t.nameKana,
          [t.areaClass, t.intensityClass].filter(Boolean).join("で") ||
            t.className,
        ].filter(Boolean)
      : [],
  );
</script>

<div class="detail stack">
  <header>
    <h1 id="detail-title">{weatherTitle(w)}</h1>
    <p class="small muted">
      {WEATHER_INFO_LABEL[w.kind]}・{facts.join("・")}
    </p>
    {#if w.cancelled || expired}
      <p class="tags">
        {#if w.cancelled}<span class="tag error">取消</span>{/if}
        {#if expired}<span class="tag">有効期限切れ</span>{/if}
      </p>
    {/if}
  </header>

  {#if w.level !== undefined && w.kindName}
    <p><WarningLevel level={w.level} label={kindText(w.kindName)} /></p>
  {:else if w.kindName && w.kind === "bosai"}
    <p class="small bold">{w.kindName}</p>
  {/if}

  {#if w.headline}
    <p class="small pre-line">{w.headline}</p>
  {/if}

  {#if t}
    <section>
      <h2>いまの台風 (実況)</h2>
      {#if typhoonFacts.length > 0}
        <p class="small">{typhoonFacts.join("・")}</p>
      {/if}
      <dl class="small facts">
        {#if t.remark}<dt>備考</dt>
          <dd>{t.remark}</dd>{/if}
        {#if t.location}
          <dt>中心</dt>
          <dd>
            {t.location}{t.lat !== undefined && t.lon !== undefined
              ? ` (北緯 ${t.lat} 度・東経 ${t.lon} 度)`
              : ""}
          </dd>
        {/if}
        {#if t.direction || t.speed}
          <dt>進み方</dt>
          <dd>{[t.direction, t.speed].filter(Boolean).join("・")}</dd>
        {/if}
        {#if t.pressureHpa !== undefined}
          <dt>中心気圧</dt>
          <dd>{t.pressureHpa} hPa</dd>
        {/if}
        {#if t.maxWindMs !== undefined}
          <dt>最大風速</dt>
          <dd>
            {t.maxWindMs} m/s{t.maxGustMs !== undefined
              ? ` (最大瞬間風速 ${t.maxGustMs} m/s)`
              : ""}
          </dd>
        {/if}
      </dl>
    </section>
    <TyphoonSection {w} />
  {/if}

  {#if w.text}
    <section>
      <h2>本文</h2>
      <p class="small pre-line">{w.text}</p>
    </section>
  {/if}

  {#if w.stations && w.stations.length > 0}
    <!-- 指定河川洪水予報の観測所ごとの実況と予想の水位 (電文の値のまま。docs/design.md の 2.8) -->
    <section data-testid="flood-stations">
      <h2>観測所の水位</h2>
      <p class="small muted">
        水位は観測所ごとの基準からの高さで、観測所どうしでは比べられません。下の基準の水位と比べて読んでください。
      </p>
      {#each w.stations as s (s.code)}
        <h3 class="small bold station">
          {s.name}
          <span class="muted"
            >{[s.location, s.base ? "基準観測所" : ""]
              .filter(Boolean)
              .join("・")}</span
          >
        </h3>
        <table class="small">
          <thead>
            <tr><th>時刻</th><th>実況・予想</th><th class="num">水位</th></tr>
          </thead>
          <tbody>
            {#each s.levels as l, i (i)}
              <tr>
                <td>{jst(l.time)}</td>
                <td>{kindText(l.label)}</td>
                <td class="num">{waterLevelText(l.m)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if s.criteria.length > 0}
          <p class="tiny muted">
            基準の水位: {s.criteria
              .map((c) => `${kindText(c.name)} ${waterLevelText(c.m)}`)
              .join("・")}
          </p>
        {/if}
      {/each}
    </section>
  {/if}

  {#if areas.length > 0}
    <section>
      <h2>{w.kind === "flood" ? "河川と府県" : "対象の地域"}</h2>
      <p class="small muted">{areas.join("、")}</p>
    </section>
  {/if}
</div>

<style>
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--so-space-1) var(--so-space-3);
    margin: var(--so-space-2) 0 0;
  }
  .facts dd {
    margin: 0;
  }
  .station {
    margin: var(--so-space-3) 0 0;
  }
  table {
    margin-top: var(--so-space-1);
  }
  td,
  th {
    padding-inline: var(--so-space-2);
    /* 7 行が 3 つの観測所ぶん並ぶので、行を詰める */
    padding-block: var(--so-space-1);
  }
  /* 水位の小数点をそろえる */
  .num {
    text-align: end;
    font-variant-numeric: tabular-nums;
  }
</style>
