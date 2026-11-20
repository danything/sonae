<script lang="ts">
  import "@anyblades/blades/content/table";

  import { alerter } from "#lib/alerter.svelte.ts";
  import { jst } from "#lib/format.ts";
  import { circleOf } from "#lib/map/typhoon.ts";
  import type { TyphoonProbability, WeatherInfo } from "#lib/model.ts";
  import { loadCities } from "#lib/push-client.ts";
  import {
    homeProbability,
    TYPHOON_PROBABILITY_REFRESH_MS,
    TYPHOON_PROBABILITY_URL,
  } from "#lib/typhoon-prob.ts";

  /**
   * 台風の詳しい内容の、予報 (予報円・暴風警戒域・強さ) と、住んでいる地域が暴風域に入る確率。
   * どちらも気象庁の発表の値のまま出す (docs/design.md の 2.8 と 5 章)。確率は通知には使わない
   */
  let { w }: { w: WeatherInfo } = $props();

  const fcs = $derived(w.typhoonForecasts ?? []);
  /** 半径 (km)。片寄った円は気象庁の図と同じく、向かい合う 2 つの半径の平均 */
  const km = (axes: { km: number; direction?: string }[]) =>
    Math.round(circleOf({ lat: 0, lon: 0 }, axes).km);

  // 住んでいる地域 (市町村等) が入る、市町村等をまとめた地域 (確率の電文の地域)
  const home = $derived(alerter.prefs.home);
  let area = $state<string | null>(null);
  $effect(() => {
    const code = home?.code;
    area = null;
    if (!code) return;
    let gone = false;
    loadCities()
      .then(({ cities }) => {
        if (!gone) area = cities[code]?.[4] ?? null;
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  });

  // その台風のいちばん新しい確率。開いている間は 10 分ごとに読み直す (新しい報が後から届くため)
  let prob = $state<TyphoonProbability | null>(null);
  let loaded = $state(false);
  let failed = $state(false);
  $effect(() => {
    const series = w.series;
    const normal = w.status === "normal";
    prob = null;
    loaded = false;
    failed = false;
    if (!normal) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await fetch(
          `${TYPHOON_PROBABILITY_URL}?series=${encodeURIComponent(series)}`,
        );
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as {
          probability: TyphoonProbability | null;
        };
        if (gone) return;
        prob = body.probability;
        failed = false;
      } catch {
        if (gone) return;
        failed = true;
      }
      loaded = true;
      timer = setTimeout(load, TYPHOON_PROBABILITY_REFRESH_MS);
    };
    void load();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  });

  const mine = $derived(
    prob && area && home ? homeProbability(prob, area, home.name) : null,
  );
  /** 「10/1 15:00〜18:00」(終わりは時刻だけ) */
  const span = (from: string, to: string) =>
    `${jst(from)}〜${jst(to).slice(-5)}`;
</script>

{#if fcs.length > 0}
  <section data-testid="typhoon-forecasts">
    <h2>予報</h2>
    <table class="small">
      <thead>
        <!-- 列の幅に収まるよう、単位は見出しの 2 行目に置き、値は数だけにする -->
        <tr>
          <th>時刻</th>
          <th class="num">中心気圧<br /><span class="muted">hPa</span></th>
          <th class="num">最大風速<br /><span class="muted">m/s</span></th>
          <th class="num">予報円<br /><span class="muted">km</span></th>
          <th class="num">暴風警戒域<br /><span class="muted">km</span></th>
        </tr>
      </thead>
      <tbody>
        {#each fcs as f (f.hours)}
          <tr>
            <td class="nowrap">{jst(f.time)}</td>
            <td class="num">{f.pressureHpa ?? "—"}</td>
            <td class="num">{f.maxWindMs ?? "—"}</td>
            <td class="num">{km(f.circle.axes)}</td>
            <td class="num">{f.stormWarning ? km(f.stormWarning) : "なし"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="tiny muted">
      予報円と暴風警戒域は半径です。予報円は、台風の中心が 70%
      の確率で入る範囲です。暴風警戒域は、台風の中心が予報円の中に進んだときに暴風域
      (風速 25 m/s 以上)
      に入るおそれのある範囲です。値は気象庁の発表のままです。
    </p>
  </section>
{/if}

{#if w.status === "normal" && !w.cancelled && fcs.length > 0}
  <section data-testid="typhoon-probability">
    <h2>住んでいる地域が暴風域に入る確率</h2>
    {#if !home}
      <p class="small muted">
        「通知」で住んでいる地域を選ぶと、その地域が暴風域に入る確率を出します。
      </p>
    {:else if failed && !prob}
      <p class="small muted">
        暴風域に入る確率を読み込めませんでした。10 分後に再試行します。
      </p>
    {:else if loaded && !prob}
      <p class="small muted">
        この台風の暴風域に入る確率は、まだ受けていません。
      </p>
    {:else if prob && mine}
      <p class="small">
        {mine.name}
        <span class="muted">({jst(prob.reportedAt)} 発表)</span>
      </p>
      {#if mine.zero}
        <p class="small">120 時間先まで、どの時間帯も 0% です。</p>
      {:else}
        <table class="small">
          <thead>
            <tr><th>期間</th><th class="num">確率</th></tr>
          </thead>
          <tbody>
            {#each mine.days as d (d.hours)}
              <tr>
                <td
                  >{d.hours} 時間先まで
                  <span class="muted">({jst(d.until)})</span></td
                >
                <td class="num">{d.p}%</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <table class="small">
          <thead>
            <tr><th>3 時間ごと</th><th class="num">確率</th></tr>
          </thead>
          <tbody>
            {#each mine.steps as s (s.from)}
              <tr>
                <td>{span(s.from, s.to)}</td>
                <td class="num">{s.p}%</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="tiny muted">ここに無い時間帯は 0% です。</p>
      {/if}
      <p class="tiny muted">
        出典：気象庁
        (台風の暴風域に入る確率)。この確率では通知しません。暴風の警報は、気象警報・注意報で通知します。
      </p>
    {/if}
  </section>
{/if}

<style>
  table {
    margin-top: var(--so-space-1);
  }
  td,
  th {
    padding-inline: var(--so-space-2);
    padding-block: var(--so-space-1);
  }
  .num {
    text-align: end;
    font-variant-numeric: tabular-nums;
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
