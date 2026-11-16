<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { untrack } from "svelte";

  import { alerter } from "#lib/alerter.svelte.ts";
  import { live } from "#lib/live.svelte.ts";
  import "../app.css";

  let { children, data } = $props();

  // load の中身を入れ、SSE の差分で更新する
  $effect.pre(() => {
    live.seed(data.snapshot);
  });
  // 埋め直しが多すぎると SSE が resync を送ってくる。load を走らせ直して一覧を取り直す。
  // resync は 1 回しか来ない (張り直しはその番号から始まる) ので、取り直せなければ 5 秒ごとにやり直す
  const resync = (): void => {
    invalidateAll().catch(() => setTimeout(resync, 5000));
  };
  // 開いているときの OS の通知と音と読み上げ (音と読み上げは端末ごとに「オフ」「通知音だけ」「読み上げも」から選ぶ。既定はオフ)。
  // start は設定を読んで書くので、読んだ値を追わない (追うと書くたびに effect が走り直して止まらない)
  $effect(() => untrack(() => alerter.start()));
  // 切れたら張り直し、切れたままなら知らせる (docs/design.md の 2.3)
  $effect(() =>
    live.connect(
      resync,
      (e) => alerter.handle(e),
      (ok) => alerter.connection(ok),
      (voice) => alerter.applyVoice(voice),
    ),
  );
</script>

<svelte:head>
  <meta name="description" content="地震・津波の情報" />
</svelte:head>

{@render children()}
