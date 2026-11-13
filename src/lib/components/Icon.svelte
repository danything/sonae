<script lang="ts">
  import type { Component } from "svelte";
  import type { SvelteHTMLElements } from "svelte/elements";

  /**
   * アイコン 1 つ (denpa の `player/Icon.svelte` と同じ)。形は Lucide (`~icons/lucide/*`。名前は https://lucide.dev/icons で引ける)。
   * 読み上げはボタンの `aria-label` か隣の字に任せるので、アイコンそのものは隠す
   */
  let {
    icon: Shape,
    size = 1.25,
  }: {
    icon: Component<SvelteHTMLElements["svg"]>;
    /** 大きさ (rem) */
    size?: number;
  } = $props();
</script>

<Shape
  width="{size}rem"
  height="{size}rem"
  style="flex-shrink: 0"
  aria-hidden="true"
/>
