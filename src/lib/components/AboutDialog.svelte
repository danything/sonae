<script lang="ts">
  import "@anyblades/blades/components/modal";

  import { alerter } from "#lib/alerter.svelte.ts";
  import { MAP_LEGEND } from "#lib/map/style.ts";
  import type { SourceStatus } from "#lib/model.ts";
  import { CREDITS, EEW_NOTICE, NOTICE } from "#lib/notice.ts";

  import StatusList from "./StatusList.svelte";

  /**
   * **出典と注意**。ヘッダー・「その他」のメニュー・地図の隅と一覧の下の短い出典から開く窓。URL の `about=1` で開いたまま共有できる。
   * 地図の色の意味 (「地図の見方」) もここに書く (層はいつも全部出していて、切り替えの並びが無いため)。
   * 「受信の状態」は、どの情報源を受けているかをいつも見られる所 (注意の印は問題があるときだけ出るため)。
   * 閉じるのは左下の「閉じる」・幕・Esc
   */
  let {
    open,
    onclose,
    connected,
    statuses,
  }: {
    open: boolean;
    onclose: () => void;
    connected: boolean;
    statuses: SourceStatus[];
  } = $props();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  closedby="any"
  aria-labelledby="about-title"
  onclose={() => open && onclose()}
>
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box">
    <h1 id="about-title">出典と注意</h1>
    <div class="stack body">
      <p>{NOTICE}</p>
      <p>{EEW_NOTICE}</p>
      <p class="small">
        緊急地震速報の予想震度・到達予想時刻は表示しません。気象庁も警報では予想震度の数字を出さず「強い揺れ」と伝えています
        (<a
          href="https://www.jma.go.jp/jma/kishou/know/jishin/eew/shikumi/shousai.html"
          target="_blank"
          rel="noopener">緊急地震速報 (警報) 及び (予報) について</a
        >)。sonae は、地点ごとの震度や到達時刻を自分で予想しません。
      </p>
      <h2>受信の状態</h2>
      <p class="small muted">
        情報源ごとの受信と、最後に受けた時刻です。開いている間も替わります
      </p>
      <div class="receive">
        <StatusList {connected} {statuses} />
      </div>
      <h2>地図の見方</h2>
      <dl class="small legend" data-testid="map-legend">
        {#each MAP_LEGEND as l (l.label)}
          <dt>{l.label}</dt>
          <dd>{l.note}</dd>
        {/each}
      </dl>
      <h2>もっと詳しく</h2>
      <ul class="small">
        <li>
          <a
            href="https://www.data.jma.go.jp/eqev/data/gaikyo/"
            target="_blank"
            rel="noopener"
            data-testid="gaikyo">各月の地震活動のまとめ (気象庁)</a
          >。月ごとの地震活動の解説と図。sonae
          には取り込まず、気象庁のページを開きます
        </li>
      </ul>
      <h2>出典</h2>
      <ul class="small" data-testid="credits">
        {#each CREDITS as c (c.label)}
          <li>
            <span class="bold">{c.label}:</span>
            {#each c.parts as p, i (i)}{#if typeof p === "string"}{p}{:else}<a
                  href={p.href}
                  target="_blank"
                  rel="noopener">{p.text}</a
                >{/if}{/each}
          </li>
        {/each}
        {#if alerter.credits.length > 0}
          <li data-testid="voice-credit">
            読み上げの声: {alerter.credits.join("・")}
          </li>
        {/if}
      </ul>
      <ul class="small">
        <li>
          <a
            href="https://www.data.jma.go.jp/developer/xml/feed/"
            target="_blank"
            rel="noopener">気象庁防災情報 XML</a
          >
          (<a
            href="https://www.jma.go.jp/jma/kishou/info/coment.html"
            target="_blank"
            rel="noopener">気象庁ホームページの利用規約</a
          >)
        </li>
        <li>
          <a href="https://www.p2pquake.net/" target="_blank" rel="noopener"
            >P2P地震情報</a
          >
        </li>
        <li>
          <a href="https://wolfx.jp/" target="_blank" rel="noopener"
            >Wolfx Project</a
          >
        </li>
        <li>
          <a href="https://earthquake.usgs.gov/" target="_blank" rel="noopener"
            >USGS Earthquake Hazards Program</a
          >
          (<a
            href="https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits"
            target="_blank"
            rel="noopener">利用条件</a
          >)
        </li>
        <li>
          <a href="https://www.seismicportal.eu/" target="_blank" rel="noopener"
            >EMSC-CSEM SeismicPortal</a
          >
          (<a
            href="https://www.seismicportal.eu/terms.html"
            target="_blank"
            rel="noopener">利用条件</a
          >、<a
            href="https://creativecommons.org/licenses/by/4.0/deed.ja"
            target="_blank"
            rel="noopener">CC BY 4.0</a
          >)
        </li>
        <li>
          <a href="https://www.geonet.org.nz/" target="_blank" rel="noopener"
            >GeoNet</a
          >
          (<a
            href="https://www.geonet.org.nz/policy"
            target="_blank"
            rel="noopener">利用条件</a
          >、<a
            href="https://creativecommons.org/licenses/by/3.0/nz/"
            target="_blank"
            rel="noopener">CC BY 3.0 NZ</a
          >)
        </li>
        <li>
          <a href="https://www.cwa.gov.tw/" target="_blank" rel="noopener"
            >中央氣象署 (台湾)</a
          >
          (<a href="https://data.gov.tw/license" target="_blank" rel="noopener"
            >政府資料開放授權條款</a
          >)
        </li>
        <li>
          <a href="https://www.tsunami.gov/" target="_blank" rel="noopener"
            >tsunami.gov (PTWC)</a
          >
          (<a
            href="https://www.weather.gov/disclaimer"
            target="_blank"
            rel="noopener">利用条件</a
          >)
        </li>
        <li>
          <a
            href="https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html"
            target="_blank"
            rel="noopener">国土地理院コンテンツ利用規約</a
          >
        </li>
        <li>
          <a
            href="https://disaportal.gsi.go.jp/hazardmap/copyright/copyright.html"
            target="_blank"
            rel="noopener">ハザードマップポータルサイトの利用規約</a
          >
        </li>
      </ul>
    </div>
    <div class="modal-foot">
      <button type="button" class="secondary" onclick={() => dialog?.close()}
        >閉じる</button
      >
    </div>
  </article>
</dialog>

<style>
  .body {
    margin-top: var(--so-space-3);
  }
  ul {
    margin: 0;
    padding-left: var(--so-space-5);
  }
  .legend {
    margin: 0;
  }
  /* 窓の中では本文の左に揃え、行を詰める (メニューの箱の並びは押しやすい高さ) */
  .receive :global(.side-list) {
    padding: 0;
  }
  .receive :global(.side-item) {
    min-height: 2rem;
    padding: 0;
  }
  .legend dt {
    font-weight: var(--so-weight-bold);
  }
  .legend dd {
    margin: 0 0 var(--so-space-2);
    color: var(--so-muted);
  }
</style>
