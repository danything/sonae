<script lang="ts">
  import "@anyblades/blades/components/modal";

  import { CREDITS, EEW_NOTICE, NOTICE } from "#lib/notice.ts";

  /**
   * **出典と注意**。ヘッダーと「その他」のメニューから開く窓。URL の `about=1` で開いたまま共有できる。
   * 情報源の状況はサイドバー (スマホの形は dock の「⋯」) の「状態」にある。閉じるのは左下の「閉じる」・幕・Esc
   */
  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
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
          rel="noopener">緊急地震速報 (警報) 及び (予報) について</a
        >)。sonae は、地点ごとの震度や到達時刻を自分で予想しません。
      </p>
      <h2>出典</h2>
      <ul class="small">
        {#each CREDITS as c (c)}
          <li>{c}</li>
        {/each}
      </ul>
      <ul class="small">
        <li>
          <a
            href="https://www.data.jma.go.jp/developer/xml/feed/"
            rel="noopener">気象庁防災情報 XML</a
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
        <li>
          <a
            href="https://maps.gsi.go.jp/development/ichiran.html"
            rel="noopener">地理院タイル一覧</a
          >
        </li>
      </ul>
    </div>
    <div class="modal-foot">
      <button
        type="button"
        class="secondary modal-close"
        onclick={() => dialog?.close()}>閉じる</button
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
</style>
