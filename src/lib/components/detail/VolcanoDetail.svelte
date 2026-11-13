<script lang="ts">
  import { jst, jstFull, STATUS_LABEL, volcanoKindText } from "#lib/format.ts";
  import type { Volcano } from "#lib/model.ts";

  import VolcanoLevel from "../VolcanoLevel.svelte";

  /**
   * 火山の情報 (噴火警報・予報、噴火速報) の詳しい内容。電文の見出し・活動の状況・防災上の警戒事項を
   * 文のまま出す。気象庁の文を言い換えない (警報を自分で作らない。docs/design.md の 5 章)
   */
  let { v }: { v: Volcano } = $props();

  const flash = $derived(v.code === "VFVO56");
  /** 事実は控えた字を「・」でつなぐ (バッジにしない) */
  const facts = $derived(
    [
      `${jstFull(v.reportedAt)} 発表`,
      v.eventTime ? `噴火 ${jst(v.eventTime)} 頃` : "",
      STATUS_LABEL[v.status],
    ].filter(Boolean),
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

  {#if v.headline}
    <p class="small text">{v.headline}</p>
  {/if}

  {#if v.volcanoes.length > 0}
    <section>
      <h2>火山</h2>
      <ul class="plain small stack">
        {#each v.volcanoes as a (a.code)}
          <li class="volcano">
            <VolcanoLevel
              level={flash ? 5 : a.level}
              label={volcanoKindText(a.kind)}
            />
            <span>
              <span class="bold">{a.name}</span>
              {#if a.condition || a.lastKind}
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

  {#if v.warning || v.cities.length > 0}
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

  {#if v.activity}
    <section>
      <h2>火山活動の状況</h2>
      <p class="small text">{v.activity}</p>
    </section>
  {/if}
  {#if v.prevention}
    <section>
      <h2>防災上の警戒事項等</h2>
      <p class="small text">{v.prevention}</p>
    </section>
  {/if}
</div>

<style>
  .text {
    white-space: pre-line;
  }
  .plain {
    margin: var(--so-space-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .volcano {
    display: flex;
    align-items: baseline;
    gap: var(--so-space-2);
  }
  .volcano > span:last-child {
    display: flex;
    flex-direction: column;
  }
</style>
