<script lang="ts">
  import "@anyblades/blades/content/table";

  import { jst, jstFull, STATUS_LABEL } from "#lib/format.ts";
  import type { Advisory } from "#lib/model.ts";

  /**
   * お知らせ (文の情報) の詳しい内容。見出し・本文を電文の文のまま出す。
   * 地震回数に関する情報 (VXSE60) は期間ごとの回数を表にする
   */
  let { a }: { a: Advisory } = $props();

  const facts = $derived(
    [`${jstFull(a.reportedAt)} 発表`, STATUS_LABEL[a.status]].filter(Boolean),
  );
  /** 期間の書き方 (「11/13 15:00 から 11/14 09:00」) */
  const span = (start?: string, end?: string) =>
    start || end ? `${jst(start)} から ${jst(end)}` : "—";
</script>

<div class="detail stack">
  <header>
    <h1 id="detail-title">
      {a.title}{a.serialName ? ` (${a.serialName})` : ""}
    </h1>
    <p class="small muted">{facts.join("・")}</p>
    {#if a.cancelled}
      <p class="tags"><span class="tag error">取消</span></p>
    {/if}
  </header>

  {#if a.code === "PTWC" || a.code === "WEPA40"}
    <p class="small">
      {a.code === "PTWC"
        ? "米国の太平洋津波警報センター (PTWC) が出した参考の情報で、気象庁の発表ではありません。"
        : "気象庁が各国の機関に向けて出す国際津波関連情報 (北西太平洋) で、日本の沿岸の津波予報ではありません。"}
      日本の沿岸の津波の警報・注意報・予報は、気象庁の津波の情報を確かめてください。
    </p>
  {/if}

  {#if a.headline}
    <p class="small text">{a.headline}</p>
  {/if}

  {#if a.counts && a.counts.length > 0}
    <section>
      <h2>地震の回数</h2>
      <table class="small">
        <thead>
          <tr><th>期間</th><th>種類</th><th>回数</th><th>震度 1 以上</th></tr>
        </thead>
        <tbody>
          {#each a.counts as c, i (i)}
            <tr>
              <td>{span(c.start, c.end)}</td>
              <td>{c.type}</td>
              <td class="num">{c.number ?? "—"}</td>
              <td class="num">{c.felt ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  {#if a.text}
    <section>
      <h2>本文</h2>
      <p class="small text">{a.text}</p>
    </section>
  {/if}
  {#if a.next}
    <p class="small muted">{a.next}</p>
  {/if}
  {#if a.url}
    <p class="small">
      <a href={a.url} target="_blank" rel="noopener noreferrer"
        >元の電報 (英文) を開く</a
      >
    </p>
  {/if}
</div>

<style>
  .text {
    white-space: pre-line;
  }
  table {
    margin-top: var(--so-space-2);
  }
  td,
  th {
    padding-inline: var(--so-space-2);
  }
</style>
