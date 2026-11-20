<script lang="ts">
  import { jstDate, jstFull, outlookDay } from "#lib/format.ts";
  import { outlookFor, type WarningOutlook } from "#lib/model.ts";

  /**
   * 1 つの府県予報区の早期注意情報 (警報級の可能性)。一次細分区域ごとに、今日から先の日ごとの「高」「中」の現象を
   * 電文の名前のまま並べる。色は付けない (警報・注意報の段の色と取り違えないため。docs/design.md の 2.8)
   */
  let {
    outlooks,
    now,
    home = null,
  }: {
    /** その府県予報区の早期注意情報 (明後日まで・明々後日以降) */
    outlooks: WarningOutlook[];
    now: number;
    /** 住んでいる地域の一次細分区域 (先に出す) */
    home?: string | null;
  } = $props();

  const today = $derived(jstDate(now));
  const office = $derived(outlooks[0]?.office.code ?? null);
  /** 一次細分区域ごと。電文の並びのまま (住んでいる地域を先に) */
  const areas = $derived.by(() => {
    const seen = new Map<string, string>();
    for (const o of outlooks)
      for (const a of o.areas) if (!seen.has(a.code)) seen.set(a.code, a.name);
    return [...seen]
      .map(([code, name]) => ({
        code,
        name,
        days: outlookFor(outlooks, { office, ichiji: code }).filter(
          (d) => d.date >= today,
        ),
      }))
      .sort((a, b) => Number(b.code === home) - Number(a.code === home));
  });
  const latest = $derived(
    outlooks.reduce(
      (t, o) => (Date.parse(o.reportedAt) > Date.parse(t) ? o.reportedAt : t),
      outlooks[0]?.reportedAt ?? "",
    ),
  );
</script>

<section>
  <h2>警報級の可能性 (早期注意情報)</h2>
  <p class="small muted">
    {latest
      ? `${jstFull(latest)} 発表・`
      : ""}警報を出す可能性が「高」「中」の日だけを並べます
  </p>
  {#if areas.every((a) => a.days.length === 0)}
    <p class="small">この先、警報級の可能性が「高」「中」の日はありません。</p>
  {:else}
    <dl class="small facts">
      {#each areas.filter((a) => a.days.length > 0) as a (a.code)}
        <dt>{a.name}</dt>
        <dd>
          {#each a.days as d (d.date)}
            <span class="day"
              >{outlookDay(d.date, now)}
              {d.kinds.map((k) => `${k.name} ${k.rank}`).join("・")}</span
            >
          {/each}
        </dd>
      {/each}
    </dl>
  {/if}
</section>

<style>
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--so-space-1) var(--so-space-3);
    margin: var(--so-space-2) 0 0;
  }
  .facts dd {
    margin: 0;
    display: flex;
    flex-direction: column;
  }
</style>
