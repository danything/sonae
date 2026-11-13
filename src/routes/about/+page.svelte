<script lang="ts">
  import "@anyblades/blades/content/table";

  import { jstFull } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { CREDITS, EEW_NOTICE, NOTICE } from "#lib/notice.ts";

  let { data } = $props();
  const view = $derived(live.view(data.snapshot));
  const NAMES: Record<string, string> = {
    jma: "気象庁 防災情報 XML",
    p2p: "P2P地震情報",
    wolfx: "Wolfx Project",
  };
  const STATES: Record<string, string> = {
    connecting: "つないでいます",
    connected: "受信中",
    retrying: "張り直しています",
    stopped: "止まっています",
  };
</script>

<svelte:head>
  <title>出典と注意 - sonae</title>
</svelte:head>

<div class="stack prose">
  <h1>出典と注意</h1>
  <section class="panel stack">
    <h2>注意</h2>
    <p>{NOTICE}</p>
    <p>{EEW_NOTICE}</p>
    <p>
      緊急地震速報の予想震度・到達予想時刻は表示しません。気象庁も警報では予想震度の数字を出さず「強い揺れ」と伝えています
      (<a
        href="https://www.jma.go.jp/jma/kishou/know/jishin/eew/shikumi/shousai.html"
        rel="noopener">緊急地震速報 (警報) 及び (予報) について</a
      >)。 sonae は、地点ごとの震度や到達時刻を自分で予想しません。
    </p>
  </section>

  <section class="panel stack">
    <h2>出典</h2>
    <ul>
      {#each CREDITS as c (c)}
        <li>{c}</li>
      {/each}
    </ul>
    <ul class="small">
      <li>
        <a href="https://www.data.jma.go.jp/developer/xml/feed/" rel="noopener"
          >気象庁防災情報 XML</a
        >
        (<a
          href="https://www.jma.go.jp/jma/kishou/info/coment.html"
          rel="noopener">気象庁ホームページの利用規約</a
        >)
      </li>
      <li>
        <a href="https://www.p2pquake.net/" rel="noopener">P2P地震情報</a>
      </li>
      <li><a href="https://wolfx.jp/" rel="noopener">Wolfx Project</a></li>
    </ul>
  </section>

  <section class="panel stack" id="status">
    <h2>情報源の状況</h2>
    {#if view.statuses.length === 0}
      <p class="muted">受信を起こしていません。</p>
    {:else}
      <table class="small">
        <thead>
          <tr><th>情報源</th><th>状態</th><th>最後に受けた</th></tr>
        </thead>
        <tbody>
          {#each view.statuses as s (s.id)}
            <tr>
              <td>{NAMES[s.id] ?? s.id}</td>
              <td
                >{STATES[s.state] ?? s.state}{s.state === "retrying" &&
                s.lastError
                  ? ` (${s.lastError})`
                  : ""}</td
              >
              <td>{jstFull(s.lastSeenAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>

<style>
  .prose {
    max-width: 48rem;
  }
  ul {
    margin: 0;
    padding-left: 1.2rem;
  }
</style>
