<script lang="ts">
  import Search from "~icons/lucide/search";

  import Icon from "./Icon.svelte";

  /**
   * 一覧を絞る欄 (震源・地域・予報区の名前)。形は denpa の `SearchField` (虫眼鏡と字と `/` の印だけの平らな面)。
   * 打つたびにその場で一覧を絞るので、候補は出さない。`/` で欄へ移る (`+page.svelte`)
   */
  let {
    value = $bindable(""),
    label = "地名で絞り込み",
  }: { value?: string; label?: string } = $props();
</script>

<form
  class="search-field"
  role="search"
  onsubmit={(event) => event.preventDefault()}
>
  <Icon icon={Search} size={1} />
  <input
    type="search"
    bind:value
    placeholder={label}
    aria-label={label}
    autocomplete="off"
    enterkeyhint="search"
    data-search-field
  />
  <kbd class="key" aria-hidden="true">/</kbd>
</form>

<style>
  .search-field {
    display: flex;
    align-items: center;
    gap: var(--so-space-2);
    width: 100%;
    min-width: 0;
    height: 2.5rem;
    margin: 0;
    padding-inline: var(--so-space-3) var(--so-space-2);
    border: 0;
    border-radius: var(--so-radius);
    background: var(--so-field);
    color: var(--so-muted);
  }
  .search-field:focus-within {
    outline: 2px solid var(--pico-primary);
    outline-offset: 2px;
  }
  .search-field input {
    flex: 1 1 0%;
    min-width: 0;
    height: auto;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    color: var(--pico-color);
    font-size: var(--so-text-sm);
    outline: none;
  }
  /* 指で押す端末は 16px (それより小さいと iPhone の Safari が押したときに拡大する) */
  @media (pointer: coarse) {
    .search-field input {
      font-size: var(--so-text-base);
    }
  }
  .key {
    padding: 0 0.375rem;
    border: 0;
    border-radius: var(--so-radius-sm);
    background: var(--so-subtle);
    color: var(--so-muted);
    font-size: var(--so-text-xs);
    line-height: 1.4;
  }
  .search-field:focus-within .key {
    display: none;
  }
  @media (pointer: coarse) {
    .key {
      display: none;
    }
  }
</style>
