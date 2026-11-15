<script lang="ts" module>
  import type { Cities } from "#lib/home.ts";
  import type { OfficeTable } from "#lib/map/style.ts";
  import {
    cityBounds,
    gsiSearchUrl,
    parseGsi,
    type Place,
  } from "#lib/places.ts";

  /** 市町村の表と外枠 (要るとき 1 度だけ読む。欄が 2 つあっても同じもの) */
  let tables:
    | Promise<{
        cities: Cities;
        bounds: Map<string, [number, number, number, number]>;
      }>
    | undefined;
  function loadTables(): NonNullable<typeof tables> {
    tables ??= Promise.all([
      fetch("/areas/cities.json").then((r) => r.json() as Promise<Cities>),
      fetch("/areas/offices.json").then(
        (r) => r.json() as Promise<OfficeTable>,
      ),
    ]).then(([cities, offices]) => ({ cities, bounds: cityBounds(offices) }));
    tables.catch(() => (tables = undefined));
    return tables;
  }

  /** 住所検索の答えは、同じ文字ならもう一度は問い合わせない (このタブの間だけ持つ) */
  const remoteCache = new Map<string, Place[]>();

  /**
   * 国土地理院の住所検索に、ブラウザから直接問い合わせる。送るのは打った文字だけ
   * (Referer も付けず、Cookie も送らない)。sonae のサーバーは通さない
   */
  async function searchGsi(
    query: string,
    signal: AbortSignal,
  ): Promise<Place[]> {
    const key = query.trim();
    const hit = remoteCache.get(key);
    if (hit) return hit;
    const res = await fetch(gsiSearchUrl(key), {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const places = parseGsi(await res.json());
    // 持ちすぎない (古いものから捨てる)
    if (remoteCache.size >= 50) {
      const first = remoteCache.keys().next().value;
      if (first !== undefined) remoteCache.delete(first);
    }
    remoteCache.set(key, places);
    return places;
  }
</script>

<script lang="ts">
  import Search from "~icons/lucide/search";

  import {
    localPlaces,
    mergePlaces,
    REMOTE_DELAY_MS,
    shouldQuery,
  } from "#lib/places.ts";

  import Icon from "./Icon.svelte";

  /**
   * 一覧を絞る欄 (震源・地域・予報区の名前)。形は denpa の `SearchField` (虫眼鏡と字と `/` の印だけの平らな面)。
   * 打つたびにその場で一覧を絞る。`/` で欄へ移る (`+page.svelte`)。
   *
   * `onplace` を渡すと、欄の下に「場所の候補」も出す (combobox。docs/map.md の「場所の検索」)。
   * 市町村は手元のデータから打つたびに、住所・地名は国土地理院の住所検索に、Enter を押したときか
   * 打つのが止まって少し経ってから (2 文字から) 問い合わせる。↑↓で選び、Enter で決め、Esc で閉じる
   */
  let {
    value = $bindable(""),
    label = "地名で絞り込み・住所で探す",
    onplace,
  }: {
    value?: string;
    label?: string;
    /** 場所の候補を選んだとき (地図をそこへ寄せる) */
    onplace?: (place: Place) => void;
  } = $props();

  const uid = $props.id();
  const listId = `places-${uid}`;

  let focused = $state(false);
  /** 候補を閉じたか (Esc・選んだ後。打ち直すと開く) */
  let dismissed = $state(false);
  let active = $state(-1);
  let data = $state<Awaited<ReturnType<typeof loadTables>>>();
  let remote = $state<{ query: string; places: Place[] }>();
  let remoteState = $state<"idle" | "loading" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const local = $derived(
    onplace && data ? localPlaces(value, data.cities, data.bounds) : [],
  );
  const places = $derived(
    mergePlaces(
      local,
      remote && remote.query === value.trim() ? remote.places : [],
    ),
  );
  const open = $derived(
    onplace !== undefined &&
      focused &&
      !dismissed &&
      value.trim() !== "" &&
      (places.length > 0 || remoteState !== "idle" || shouldQuery(value)),
  );

  function ensureData(): void {
    if (!onplace || data) return;
    loadTables()
      .then((t) => (data = t))
      .catch(() => {
        // 市町村の候補が出ないだけ
      });
  }

  /** 住所検索に問い合わせる (前の問い合わせは取りやめる) */
  function searchNow(): void {
    clearTimeout(timer);
    const q = value.trim();
    if (!onplace || !shouldQuery(q)) return;
    if (remote?.query === q) return;
    controller?.abort();
    const c = new AbortController();
    controller = c;
    remoteState = "loading";
    searchGsi(q, c.signal)
      .then((ps) => {
        if (c.signal.aborted) return;
        remote = { query: q, places: ps };
        remoteState = "idle";
      })
      .catch(() => {
        if (!c.signal.aborted) remoteState = "failed";
      });
  }

  function oninput(): void {
    dismissed = false;
    active = -1;
    ensureData();
    clearTimeout(timer);
    controller?.abort();
    remoteState = "idle";
    if (onplace && shouldQuery(value))
      timer = setTimeout(searchNow, REMOTE_DELAY_MS);
  }

  function choose(p: Place): void {
    dismissed = true;
    active = -1;
    onplace?.(p);
  }

  function onkeydown(event: KeyboardEvent): void {
    // 変換を確定する Enter は選ばない (Safari は確定の Enter を isComposing でなく keyCode 229 で送る)
    if (!onplace || event.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (places.length === 0) return;
        event.preventDefault();
        dismissed = false;
        const n = places.length;
        active =
          event.key === "ArrowDown"
            ? (active + 1) % n
            : active <= 0
              ? n - 1
              : active - 1;
        return;
      }
      case "Enter": {
        const p = open ? places[active] : undefined;
        event.preventDefault();
        if (p) choose(p);
        else {
          dismissed = false;
          searchNow();
        }
        return;
      }
      case "Escape":
        if (open) {
          // 候補だけを閉じる (欄の字は消さない)
          event.preventDefault();
          dismissed = true;
          active = -1;
        }
        return;
    }
  }

  $effect(() => () => {
    clearTimeout(timer);
    controller?.abort();
  });
</script>

<div class="search-wrap">
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
      role={onplace ? "combobox" : undefined}
      aria-autocomplete={onplace ? "list" : undefined}
      aria-expanded={onplace ? open : undefined}
      aria-controls={onplace ? listId : undefined}
      aria-activedescendant={open && active >= 0
        ? `${listId}-${active}`
        : undefined}
      {oninput}
      {onkeydown}
      onfocus={() => {
        focused = true;
        ensureData();
      }}
      onblur={() => (focused = false)}
    />
    <kbd class="key" aria-hidden="true">/</kbd>
  </form>
  {#if onplace}
    <div class="places" id="{listId}-box" hidden={!open} data-testid="places">
      <p class="places-head tiny muted">場所の候補</p>
      <ul id={listId} role="listbox" aria-label="場所の候補">
        {#each places as p, i (p.id)}
          <!-- キーボードでは欄の ↑↓ と Enter で選ぶ (combobox の aria-activedescendant)。候補そのものは押すだけ -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="{listId}-{i}"
            role="option"
            aria-selected={i === active}
            class="place"
            data-kind={p.kind}
            onpointerdown={(event) => event.preventDefault()}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => choose(p)}
          >
            <span class="place-label">{p.label}</span>
            <span class="tiny muted"
              >{p.kind === "city" ? "市町村" : "住所・地名"}</span
            >
          </li>
        {/each}
      </ul>
      <p class="places-foot tiny muted" role="status">
        {#if remoteState === "loading"}
          住所を探しています…
        {:else if remoteState === "failed"}
          住所を探せませんでした
          (国土地理院の住所検索)。市町村だけを出しています
        {:else if remote && remote.query === value.trim()}
          住所: 国土地理院の住所検索
        {:else if shouldQuery(value)}
          Enter で住所も探します
        {/if}
      </p>
    </div>
  {/if}
</div>

<style>
  .search-wrap {
    position: relative;
    width: 100%;
    min-width: 0;
  }
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
  /*
   * 場所の候補。欄の下に重なるので操作の層 (メニューと同じ面と影)。選んでいる候補はメニューと同じ地の色
   * (↑↓で動く所。押されている印ではない)
   */
  .places {
    position: absolute;
    top: calc(100% + var(--so-space-1));
    left: 0;
    right: 0;
    z-index: 20;
    max-height: min(24rem, 60dvh);
    overflow-y: auto;
    padding: var(--so-space-2);
    border-radius: var(--so-radius-lg);
    background: var(--so-pop);
    box-shadow: var(--so-shadow-pop);
    color: var(--pico-color);
  }
  .places[hidden] {
    display: none;
  }
  .places ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .places-head,
  .places-foot {
    margin: 0;
    padding: var(--so-space-1) var(--so-space-3);
  }
  .places-foot:empty {
    display: none;
  }
  .place {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--so-space-2);
    margin: 0;
    padding: var(--so-space-2) var(--so-space-3);
    border-radius: calc(var(--so-radius-lg) - var(--so-space-2));
    list-style: none;
    cursor: pointer;
  }
  .place:hover,
  .place[aria-selected="true"] {
    background: var(--so-pop-hover);
  }
  .place-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .place .muted {
    flex-shrink: 0;
  }
</style>
