<script lang="ts">
  import { invalidateAll } from "$app/navigation";

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
  $effect(() => live.connect(resync));
</script>

<svelte:head>
  <meta name="description" content="地震・津波の情報" />
</svelte:head>

{@render children()}
