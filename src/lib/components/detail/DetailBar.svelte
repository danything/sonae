<script lang="ts">
  import ChevronLeft from "~icons/lucide/chevron-left";
  import MapIcon from "~icons/lucide/map";

  import Icon from "../Icon.svelte";

  /**
   * 詳しい内容の上の 1 行。左に一覧へ戻るリンク、スマホの形では右に「地図で見る」(地図のタブへ移る)。
   * どちらも字だけのボタン (平ら)
   */
  let { backHref, onmap }: { backHref: string; onmap: () => void } = $props();
</script>

<div class="detail-bar">
  <a class="button ghost small" href={backHref} data-testid="back">
    <Icon icon={ChevronLeft} size={1} />一覧
  </a>
  <button type="button" class="ghost small to-map" onclick={onmap}>
    <Icon icon={MapIcon} size={1} />地図で見る
  </button>
</div>

<style>
  .detail-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 calc(-1 * var(--so-space-3));
  }
  :global(:where(html:not([data-phone]))) .to-map {
    display: none;
  }
</style>
