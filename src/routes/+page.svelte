<script lang="ts">
  import { browser } from "$app/env";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { tick } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import Ellipsis from "~icons/lucide/ellipsis";
  import ExternalLink from "~icons/lucide/external-link";
  import Info from "~icons/lucide/info";
  import List from "~icons/lucide/list";
  import MapIcon from "~icons/lucide/map";
  import TriangleAlert from "~icons/lucide/triangle-alert";
  import VolumeX from "~icons/lucide/volume-x";

  import { alerter } from "#lib/alerter.svelte.ts";
  import AboutDialog from "#lib/components/AboutDialog.svelte";
  import Calendar from "#lib/components/Calendar.svelte";
  import DetailBar from "#lib/components/detail/DetailBar.svelte";
  import EewDetail from "#lib/components/detail/EewDetail.svelte";
  import QuakeDetail from "#lib/components/detail/QuakeDetail.svelte";
  import TsunamiDetail from "#lib/components/detail/TsunamiDetail.svelte";
  import EewBanner from "#lib/components/EewBanner.svelte";
  import Grade from "#lib/components/Grade.svelte";
  import Icon from "#lib/components/Icon.svelte";
  import Intensity from "#lib/components/Intensity.svelte";
  import Menu from "#lib/components/Menu.svelte";
  import PushSettings from "#lib/components/PushSettings.svelte";
  import QuakeMap from "#lib/components/QuakeMap.svelte";
  import Row from "#lib/components/Row.svelte";
  import SearchField from "#lib/components/SearchField.svelte";
  import StatusList from "#lib/components/StatusList.svelte";
  import TsunamiSummary from "#lib/components/TsunamiSummary.svelte";
  import ViewList from "#lib/components/ViewList.svelte";
  import { activeEews } from "#lib/eew.ts";
  import {
    depthText,
    jst,
    jstClock,
    jstTime,
    magnitudeText,
    placeName,
    quakeName,
    STATUS_LABEL,
  } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { type LayerId, type LayerState, readLayers } from "#lib/map/style.ts";
  import {
    type Eew,
    isTsunamiActive,
    isUrgentAdvisory,
    type Quake,
    type Tsunami,
    tsunamiGradeLabel,
    tsunamiTop,
  } from "#lib/model.ts";
  import { CREDITS, KMONI_URL, NOTICE } from "#lib/notice.ts";
  import { PHONE_FORM } from "#lib/phone-form.ts";
  import {
    applyTheme,
    readPref,
    type ThemeMode,
    writePref,
  } from "#lib/prefs.ts";
  import {
    dayKey,
    dayLabel,
    groupByDay,
    type Kind,
    KIND_LABEL,
    KINDS,
    matches,
    readView,
    selectHref,
    viewHref,
  } from "#lib/view.ts";

  /**
   * **sonae の画面はこれ 1 つ** (docs/ui.md)。地図が主で、一覧・詳しい内容・状態・層の切り替えを同じ画面に置く。
   *
   * - 広い形 (1000px から): 上に全幅のヘッダー (左にロゴ、真ん中に地名で絞る欄、右に字だけのナビ)。
   *   その下に 一覧 (と、選んだときは詳しい内容) | 地図 | サイドバー (カレンダー・状態・絞り込み・表示)
   * - スマホの形: ヘッダーを出さず、地図を画面いっぱいに。一覧は地図の上に重ねる面で、下のタブ (地図・一覧・その他) で切り替える。
   *   下のタブのすぐ上に操作の 1 行 (dock。一覧の種類と「⋯」)。一覧を下へ読むと、下のタブと dock は引っ込む
   *
   * 何を見ているかは URL の query に持つ (`#lib/view.ts`)。行を押すと `?q=<id>` などに替わり、そのリンクを送れば同じ所が開く
   */
  let { data } = $props();

  const params = $derived(page.url.searchParams);
  const v = $derived(readView(params));
  const snap = $derived(live.view(data.snapshot));
  const phone = new MediaQuery(PHONE_FORM, false);

  // ---- 一覧 ----
  let query = $state("");
  const quakes = $derived(
    snap.quakes.filter((q) =>
      matches(query, q.hypocenter?.name, ...q.areas.map((a) => a.name)),
    ),
  );
  const tsunamis = $derived(
    snap.tsunamis.filter((t) =>
      matches(query, t.headline, ...t.areas.map((a) => a.name)),
    ),
  );
  /** 緊急地震速報。訓練・試験を出していないときは、SSE で来たもの (通常だけ) を重ねる */
  const allEews = $derived(
    data.training
      ? data.eewHistory
      : [
          ...snap.eews.filter(
            (e) => !data.eewHistory.some((h) => h.eventId === e.eventId),
          ),
          ...data.eewHistory.map(
            (h) => snap.eews.find((e) => e.eventId === h.eventId) ?? h,
          ),
        ],
  );
  const eews = $derived(
    allEews.filter((e) => matches(query, e.hypocenter?.name, ...e.warnAreas)),
  );
  const counts = $derived<Record<Kind, number>>({
    quake: quakes.length,
    tsunami: tsunamis.length,
    eew: eews.length,
  });

  const quakeTime = (q: Quake) => q.originTime ?? q.updatedAt;
  const groups = $derived.by(() => {
    switch (v.kind) {
      case "quake":
        return groupByDay(quakes, quakeTime).map((g) => ({
          day: g.day,
          rows: g.items.map((q) => quakeRow(q)),
        }));
      case "tsunami":
        return groupByDay(tsunamis, (t) => t.issuedAt).map((g) => ({
          day: g.day,
          rows: g.items.map((t) => tsunamiRow(t)),
        }));
      case "eew":
        return groupByDay(eews, (e) => e.issuedAt).map((g) => ({
          day: g.day,
          rows: g.items.map((e) => eewRow(e)),
        }));
    }
  });

  interface RowData {
    key: string;
    href: string;
    current: boolean;
    time: string;
    title: string;
    meta: string;
    quake?: Quake;
    grade?: Tsunami["areas"][number]["grade"];
    states: { label: string; tone: "error" | "info" | "" }[];
  }
  function quakeRow(q: Quake): RowData {
    return {
      key: q.id,
      href: selectHref(params, "quake", q.id),
      current: v.selected?.kind === "quake" && v.selected.id === q.id,
      time: jstTime(quakeTime(q)),
      title: quakeName(q),
      meta: [
        magnitudeText(q),
        `深さ ${depthText(q.hypocenter)}`,
        q.foreign ? "遠地地震" : "",
      ]
        .filter(Boolean)
        .join("・"),
      quake: q,
      states: [
        ...(q.cancelled ? [{ label: "取消", tone: "error" as const }] : []),
        ...(q.provisional ? [{ label: "速報", tone: "info" as const }] : []),
      ],
    };
  }
  function tsunamiRow(t: Tsunami): RowData {
    const top = tsunamiTop(t);
    const active = isTsunamiActive(t, live.now);
    return {
      key: t.id,
      href: selectHref(params, "tsunami", t.id),
      current: v.selected?.kind === "tsunami" && v.selected.id === t.id,
      time: jstTime(t.issuedAt),
      title: t.cancelled
        ? "津波の情報 (取消)"
        : t.ended
          ? "津波の警報・注意報・予報の解除"
          : active
            ? tsunamiGradeLabel(top)
            : "終わった津波予報",
      meta: t.areas
        .filter((a) => a.grade !== "none")
        .map((a) => a.name)
        .join("、"),
      grade: active ? top : undefined,
      states: t.provisional ? [{ label: "速報", tone: "info" }] : [],
    };
  }
  function eewRow(e: Eew): RowData {
    return {
      key: `${e.eventId}-${e.status}`,
      href: selectHref(params, "eew", e.eventId),
      current: v.selected?.kind === "eew" && v.selected.id === e.eventId,
      time: jstClock(e.issuedAt),
      title: placeName(e.hypocenter),
      meta: [
        e.kind === "warning" ? "警報" : "予報",
        `第 ${e.serial} 報${e.final ? " (最終)" : ""}`,
        e.magnitude !== undefined ? magnitudeText(e) : "",
        e.warnAreas.length > 0 ? e.warnAreas.join("、") : "",
      ]
        .filter(Boolean)
        .join("・"),
      states: [
        ...(e.cancelled ? [{ label: "取消", tone: "error" as const }] : []),
        ...(e.status !== "normal"
          ? [{ label: STATUS_LABEL[e.status], tone: "" as const }]
          : []),
      ],
    };
  }

  // ---- 一覧の上に出す、いま出ているもの ----
  const activeTsunamis = $derived(
    snap.tsunamis.filter((t) => isTsunamiActive(t, live.now)),
  );
  const WEEK = 7 * 24 * 60 * 60_000;
  const advisories = $derived(
    snap.advisories.filter(
      (a) => !a.cancelled && Date.parse(a.reportedAt) > live.now - WEEK,
    ),
  );
  const banners = $derived(browser ? activeEews(snap.eews, live.now) : []);

  // ---- 選んだもの (SSE で続報が来たら差し替える) ----
  const selQuake = $derived(
    v.selected?.kind === "quake"
      ? (snap.quakes.find((q) => q.id === v.selected?.id) ?? data.quake)
      : null,
  );
  const selTsunami = $derived(
    v.selected?.kind === "tsunami"
      ? (snap.tsunamis.find((t) => t.id === v.selected?.id) ?? data.tsunami)
      : null,
  );
  const selEew = $derived(
    v.selected?.kind === "eew"
      ? (allEews.find((e) => e.eventId === v.selected?.id) ?? data.eew)
      : null,
  );
  const backHref = $derived(viewHref(params, { q: null, t: null, e: null }));

  // ---- 地図 ----
  const mapQuake = $derived(selQuake ?? snap.quakes[0]);
  const mapTsunamis = $derived(selTsunami ? [selTsunami] : activeTsunamis);
  const mapEews = $derived(selEew ? [selEew] : banners);
  // 層のオン・オフは端末に覚えさせる
  let layers = $state<LayerState>(readLayers(null));
  $effect.pre(() => {
    layers = readLayers(readPref("map.layers"));
  });
  function toggleLayer(id: LayerId) {
    layers[id] = !layers[id];
    writePref("map.layers", JSON.stringify(layers));
  }
  const trainingHref = $derived(
    viewHref(params, { k: "eew", training: data.training ? null : "1" }),
  );

  // ---- スマホの形: 地図と一覧の切り替え (選んだもので開いたときは一覧) ----
  // svelte-ignore state_referenced_locally
  let tab = $state<"map" | "list">(v.selected ? "list" : "map");
  let listBox = $state<HTMLElement>();
  /** 一覧を下へ読んでいる間は、下のタブと dock を引っ込める (動きは CSS) */
  let retract = $state(false);
  let lastTop = 0;
  function onListScroll() {
    if (!listBox) return;
    const y = listBox.scrollTop;
    if (y < 48) retract = false;
    else if (y - lastTop > 4) retract = true;
    else if (lastTop - y > 4) retract = false;
    lastTop = y;
  }
  $effect(() => {
    if (tab === "map") retract = false;
  });
  // 選び直したら、一覧の箱を先頭へ戻す (詳しい内容の始まりから読む)
  $effect(() => {
    void v.selected?.id;
    listBox?.scrollTo({ top: 0, behavior: "instant" });
  });

  // ---- カレンダー ----
  const today = $derived(dayKey(new Date(live.now).toISOString()));
  const marks = $derived(
    new Map(groups.map((g) => [g.day, g.rows.length] as const)),
  );
  let picked = $state<string | null>(null);
  const pinned = $derived(
    selQuake
      ? dayKey(quakeTime(selQuake))
      : selTsunami
        ? dayKey(selTsunami.issuedAt)
        : selEew
          ? dayKey(selEew.issuedAt)
          : picked,
  );
  async function pickDay(day: string) {
    picked = day;
    if (v.selected) await goto(backHref, { reset: false });
    await tick();
    document.getElementById(`day-${day}`)?.scrollIntoView({ block: "start" });
  }

  // ---- テーマ (暗い・明るい・端末に合わせる。既定は暗い) ----
  const THEMES: { mode: ThemeMode; label: string }[] = [
    { mode: "dark", label: "暗い" },
    { mode: "light", label: "明るい" },
    { mode: "system", label: "端末に合わせる" },
  ];
  let theme = $state<ThemeMode>("dark");
  $effect(() => {
    const m = document.documentElement.dataset.themeMode;
    if (m === "light" || m === "system" || m === "dark") theme = m;
  });
  function setTheme(mode: ThemeMode) {
    theme = mode;
    applyTheme(mode);
  }

  // ---- 状態 (つながっていないものがあれば、ヘッダーと dock の「⋯」に注意の印) ----
  const trouble = $derived(
    browser &&
      (!live.connected || snap.statuses.some((s) => s.state !== "connected")),
  );

  // ---- 出典と注意 ----
  const aboutHref = $derived(viewHref(params, { about: "1" }));
  const closeAbout = () =>
    goto(viewHref(params, { about: null }), {
      reset: false,
      replace: true,
    });

  /** 通知 (Web Push) の設定の窓 */
  let pushOpen = $state(false);
  let userMenu = $state(false);
  let moreMenu = $state(false);
  let dockMenu = $state(false);

  /** `/` か Ctrl+K で、見えている絞り込みの欄へ */
  function searchShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const slash =
      event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
    const k =
      event.key.toLowerCase() === "k" &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey;
    if (!slash && !k) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest("input, textarea, select, dialog") !== null)
    )
      return;
    const field = [
      ...document.querySelectorAll<HTMLInputElement>("[data-search-field]"),
    ].find((input) => input.getClientRects().length > 0);
    if (!field) return;
    event.preventDefault();
    if (phone.current) tab = "list";
    field.focus();
    field.select();
  }

  const title = $derived(
    selQuake
      ? `${quakeName(selQuake)} ${jst(quakeTime(selQuake))} - sonae`
      : selTsunami
        ? `津波 ${jst(selTsunami.issuedAt)} - sonae`
        : selEew
          ? `緊急地震速報 ${jst(selEew.issuedAt)} - sonae`
          : `${KIND_LABEL[v.kind]} - sonae`,
  );
  const user = $derived(data.user);
</script>

<svelte:window onkeydown={searchShortcut} />

<svelte:head>
  <title>{title}</title>
</svelte:head>

{#snippet logo()}
  <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="currentColor" />
    <path
      d="M4 17h5l3-7 4 13 3-9 2 3h7"
      fill="none"
      stroke="#fff"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
{/snippet}

{#snippet kmoniItem()}
  <!-- 防災科研の公式の強震モニタ。リンクだけ (データは取らず、埋め込まない。docs/design.md 1 章) -->
  <a
    class="menu-item kmoni"
    href={KMONI_URL}
    target="_blank"
    rel="noopener noreferrer"
    data-testid="kmoni"
  >
    強震モニタを開く
    <Icon icon={ExternalLink} size={0.875} />
  </a>
{/snippet}

{#snippet soundButton(cls: string)}
  <!-- 音か読み上げがオンなのに、ブラウザが音を止めている (最初の操作の前)。押すと鳴らせるようになる -->
  <button
    type="button"
    class="ghost {cls} sound-blocked"
    onclick={() => alerter.unlock()}
    title="ブラウザが音を止めています。押すと、受けたときに音と読み上げで知らせます"
    data-testid="sound-blocked"
  >
    <Icon icon={VolumeX} size={1} />
    音を出す
  </button>
{/snippet}

{#snippet themeItems()}
  <p class="menu-head">テーマ</p>
  {#each THEMES as t (t.mode)}
    <button
      type="button"
      role="menuitemradio"
      class="menu-item"
      aria-checked={theme === t.mode}
      onclick={() => setTheme(t.mode)}>{t.label}</button
    >
  {/each}
{/snippet}

{#snippet accountItems()}
  {#if user && user.subject !== "dev"}
    <div class="menu-gap"></div>
    <form method="POST" action="/auth/logout" class="menu-form">
      <button type="submit" class="menu-item" data-testid="logout"
        >ログアウト</button
      >
    </form>
  {/if}
{/snippet}

{#snippet credits(where: string)}
  <!-- 注意文と出典 (docs/design.md の 5 章)。広い形はサイドバーの下、スマホの形は一覧の下 -->
  <footer class="foot {where} tiny muted">
    <p>{NOTICE}</p>
    <ul>
      {#each CREDITS as c (c)}<li>{c}</li>{/each}
    </ul>
  </footer>
{/snippet}

{#snippet dockMenuBody()}
  <p class="menu-head">状態</p>
  <StatusList connected={live.connected} statuses={snap.statuses} />
  <div class="menu-gap"></div>
  <p class="menu-head">表示</p>
  <ViewList
    {layers}
    toggle={toggleLayer}
    training={data.training}
    {trainingHref}
    variant="menu"
  />
{/snippet}

<div
  class="shell"
  data-view={tab}
  data-sveltekit-reset="false"
  data-retract={retract ? "" : undefined}
  data-testid="shell"
>
  <a class="skip" href="#list">一覧へ移動</a>

  {#if banners.length > 0}
    <div class="alerts">
      {#each banners as eew (eew.eventId)}
        <EewBanner {eew} />
      {/each}
    </div>
  {/if}

  <!-- 広い形のヘッダー (スマホの形では出さない) -->
  <header class="navbar">
    <a class="logo" href="/" aria-label="sonae (地震の一覧へ)">
      {@render logo()}
      <span>sonae</span>
    </a>
    <div class="header-search">
      <SearchField bind:value={query} />
    </div>
    <nav class="actions" aria-label="メニュー">
      {#if alerter.blocked}
        {@render soundButton("small")}
      {/if}
      {#if trouble}
        <span class="trouble" role="status">
          <Icon icon={TriangleAlert} size={1} />
          {live.connected ? "受信に問題があります" : "配信が切れています"}
        </span>
      {/if}
      <a class="button ghost small" href={aboutHref}>出典と注意</a>
      {#if user}
        <button
          type="button"
          class="ghost small"
          onclick={() => (pushOpen = true)}
          data-testid="push-open">通知</button
        >
      {/if}
      <Menu bind:open={userMenu} align="end">
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="ghost small"
            data-testid="user-menu">{user?.name ?? "メニュー"}</button
          >
        {/snippet}
        {@render kmoniItem()}
        <div class="menu-gap"></div>
        {@render themeItems()}
        {@render accountItems()}
      </Menu>
    </nav>
  </header>

  <main class="stage">
    <section
      id="list"
      class="list-pane"
      aria-label={v.selected ? "詳しい内容" : `${KIND_LABEL[v.kind]}の一覧`}
      bind:this={listBox}
      onscroll={onListScroll}
      inert={phone.current && tab === "map" ? true : undefined}
      tabindex="-1"
    >
      <div class="phone-search">
        <SearchField bind:value={query} />
      </div>

      {#if v.selected}
        <DetailBar {backHref} onmap={() => (tab = "map")} />
        {#if selQuake}
          <QuakeDetail q={selQuake} />
        {:else if selTsunami}
          <TsunamiDetail t={selTsunami} now={live.now} />
        {:else if selEew}
          <EewDetail e={selEew} />
        {:else}
          <div class="empty-state">
            <p class="bold">この情報はありません</p>
            <p class="small muted">
              保存していないか、取り消されたものです。一覧から選んでください。
            </p>
          </div>
        {/if}
      {:else}
        {#if activeTsunamis.length > 0 || advisories.length > 0}
          <div class="alerts-in-list stack">
            {#each activeTsunamis as t (t.id)}
              <TsunamiSummary
                tsunami={t}
                href={selectHref(params, "tsunami", t.id)}
              />
            {/each}
            {#each advisories as a (a.id)}
              <section
                class="notice"
                class:warning={isUrgentAdvisory(a)}
                class:info={!isUrgentAdvisory(a)}
              >
                <Icon icon={isUrgentAdvisory(a) ? TriangleAlert : Info} />
                <div>
                  <p class="bold">{a.title}</p>
                  <p class="small muted">{jst(a.reportedAt)} 発表</p>
                  <p class="small">{a.headline}</p>
                </div>
              </section>
            {/each}
          </div>
        {/if}

        <h1 class="visually-hidden">{KIND_LABEL[v.kind]}の一覧</h1>
        {#each groups as g (g.day)}
          <h2 class="day-head" id="day-{g.day}">
            <span class="day-head-chip">{dayLabel(g.day)}</span>
          </h2>
          <ol class="item-list">
            {#each g.rows as r (r.key)}
              <li>
                <Row
                  href={r.href}
                  current={r.current}
                  time={r.time}
                  title={r.title}
                  meta={r.meta}
                >
                  {#snippet lead()}
                    {#if v.kind === "quake"}
                      <Intensity int={r.quake?.maxInt} />
                    {:else if v.kind === "tsunami" && r.grade}
                      <Grade grade={r.grade} />
                    {/if}
                  {/snippet}
                  {#snippet tags()}
                    {#each r.states as s (s.label)}
                      <span class="tag {s.tone}">{s.label}</span>
                    {/each}
                  {/snippet}
                </Row>
              </li>
            {/each}
          </ol>
        {:else}
          <div class="empty-state">
            {#if query.trim() !== ""}
              <p class="bold">当てはまるものはありません</p>
            {:else}
              <p class="bold">
                まだ{KIND_LABEL[v.kind]}の情報を受けていません
              </p>
              <p class="small muted">
                受けると、ここに新しい順で並びます。受信の状態は「状態」で確かめられます。
              </p>
            {/if}
          </div>
        {/each}
      {/if}

      <!-- 注意文と出典 (広い形はサイドバーの下にある) -->
      {@render credits("phone-foot")}
    </section>

    <div class="map-pane">
      <QuakeMap
        quake={mapQuake}
        quakes={snap.quakes}
        tsunamis={mapTsunamis}
        eews={mapEews}
        {layers}
        shown={!phone.current || tab === "map"}
      />
    </div>

    <aside class="side-panel" aria-label="状態と絞り込みと表示">
      <Calendar {marks} {today} {pinned} onpick={pickDay} />

      <h2 class="side-label">状態</h2>
      <StatusList connected={live.connected} statuses={snap.statuses} />

      <h2 class="side-label">絞り込み</h2>
      <div class="side-list" role="group" aria-label="一覧の種類">
        {#each KINDS as k (k)}
          <a
            class="side-item"
            href={viewHref(params, { k, q: null, t: null, e: null })}
            aria-current={!v.selected && v.kind === k ? "true" : undefined}
            data-testid="filter-{k}"
          >
            <span>{KIND_LABEL[k]}</span>
            <span class="side-sub num">{counts[k]}</span>
          </a>
        {/each}
      </div>

      <h2 class="side-label">表示</h2>
      <div class="side-list" role="group" aria-label="表示の切り替え">
        <ViewList
          {layers}
          toggle={toggleLayer}
          training={data.training}
          {trainingHref}
        />
      </div>

      {@render credits("side-foot")}
    </aside>
  </main>

  <!-- スマホの形: 下のタブのすぐ上の操作の 1 行 -->
  <div class="dock" role="toolbar" aria-label="一覧の種類と表示">
    {#if tab === "list"}
      <div class="chips scroll" role="group" aria-label="一覧の種類">
        {#each KINDS as k (k)}
          <a
            class="chip"
            href={viewHref(params, { k, q: null, t: null, e: null })}
            aria-current={!v.selected && v.kind === k ? "true" : undefined}
          >
            {KIND_LABEL[k]} <span class="num">{counts[k]}</span>
          </a>
        {/each}
      </div>
    {:else if mapQuake}
      <a
        class="dock-quake"
        href={selectHref(params, "quake", mapQuake.id)}
        onclick={() => (tab = "list")}
      >
        <Intensity int={mapQuake.maxInt} size="sm" />
        <span class="truncate"
          >{quakeName(mapQuake)}・{jst(quakeTime(mapQuake))}</span
        >
      </a>
    {:else}
      <span class="dock-quake muted small">まだ地震の情報はありません</span>
    {/if}
    {#if alerter.blocked}
      {@render soundButton("small dock-sound")}
    {/if}
    <Menu bind:open={dockMenu} side="top" align="end" class="dock-menu">
      {#snippet trigger(props)}
        <button
          {...props}
          type="button"
          class="ghost icon small dock-more"
          class:warn={trouble}
          aria-label={trouble
            ? "状態と表示 (受信に問題があります)"
            : "状態と表示"}
        >
          <Icon icon={trouble ? TriangleAlert : Ellipsis} />
        </button>
      {/snippet}
      {@render dockMenuBody()}
    </Menu>
  </div>

  <!-- スマホの形の下のタブ -->
  <nav class="tabbar" aria-label="画面の切り替え">
    <button
      type="button"
      class="tab"
      aria-current={tab === "map" ? "page" : undefined}
      onclick={() => (tab = "map")}
      data-testid="tab-map"
    >
      <Icon icon={MapIcon} />
      <span>地図</span>
    </button>
    <button
      type="button"
      class="tab"
      aria-current={tab === "list" ? "page" : undefined}
      onclick={() => (tab = "list")}
      data-testid="tab-list"
    >
      <Icon icon={List} />
      <span>一覧</span>
    </button>
    <div class="tab-more">
      <Menu bind:open={moreMenu} side="top" align="end" nav>
        {#snippet trigger(props)}
          <button {...props} type="button" class="tab" data-testid="tab-more">
            <Icon icon={Ellipsis} />
            <span>その他</span>
          </button>
        {/snippet}
        {#if user}<p class="menu-head">{user.name}</p>{/if}
        <a class="menu-item" href={aboutHref}>出典と注意</a>
        {#if user}
          <button
            type="button"
            class="menu-item"
            onclick={() => (pushOpen = true)}>通知</button
          >
        {/if}
        {@render kmoniItem()}
        <div class="menu-gap"></div>
        {@render themeItems()}
        {@render accountItems()}
      </Menu>
    </div>
  </nav>

  <AboutDialog open={v.about} onclose={closeAbout} />
  {#if user}
    <PushSettings bind:open={pushOpen} />
  {/if}
</div>

<style>
  /*
   * 1 つの画面の外枠。窓の高さいっぱいにし、ページそのものは巻かない (一覧とサイドバーはそれぞれの箱の中で巻く)。
   * 広い形は ヘッダー / 一覧 | 地図 | サイドバー。スマホの形は地図を画面いっぱいにし、一覧はその上に重ねる面
   */
  .shell {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--so-bg);
  }
  .alerts {
    flex: none;
  }
  .skip {
    position: fixed;
    top: calc(env(safe-area-inset-top) + var(--so-space-2));
    left: var(--so-space-3);
    z-index: var(--so-z-skip);
    padding: var(--so-space-2) var(--so-space-4);
    border-radius: var(--so-radius-full);
    background: var(--so-float);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
    font-weight: var(--so-weight-bold);
    text-decoration: none;
    translate: 0 calc(-100% - 2rem);
  }
  .skip:focus {
    translate: none;
  }

  /* ---- ヘッダー (広い形)。窓が巻けないので、いつも平ら (denpa の観る画面と同じ) ---- */
  .navbar {
    display: grid;
    flex: none;
    grid-template-columns:
      minmax(max-content, 1fr) minmax(8rem, 36rem)
      minmax(max-content, 1fr);
    align-items: center;
    gap: var(--so-space-4);
    min-height: 3.25rem;
    padding: var(--so-bar-pad) var(--so-space-3);
  }
  .logo {
    display: inline-flex;
    align-items: center;
    gap: var(--so-space-2);
    justify-self: start;
    color: var(--so-fg);
    font-size: var(--so-text-lg);
    font-weight: var(--so-weight-bold);
    text-decoration: none;
  }
  .logo-mark {
    width: 1.5rem;
    height: 1.5rem;
    color: var(--pico-primary-background);
  }
  .actions {
    display: flex;
    align-items: center;
    justify-self: end;
    gap: 0.125rem;
  }
  .actions :global(:is(a.button, button)) {
    font-size: var(--so-text-sm);
  }
  .kmoni {
    display: flex;
    align-items: center;
    gap: var(--so-space-1);
  }
  .sound-blocked {
    gap: var(--so-space-1);
    color: var(--so-warn-text);
    white-space: nowrap;
  }
  .trouble {
    display: inline-flex;
    align-items: center;
    gap: var(--so-space-1);
    margin-right: var(--so-space-2);
    color: var(--so-warn-text);
    font-size: var(--so-text-xs);
    white-space: nowrap;
  }

  /* ---- 本体 (広い形): 一覧 | 地図 | サイドバー ---- */
  .stage {
    display: grid;
    flex: 1 1 0%;
    grid-template-columns: 24rem minmax(0, 1fr) 20rem;
    min-height: 0;
  }
  .list-pane {
    display: flex;
    flex-direction: column;
    gap: var(--so-space-2);
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--so-space-3) var(--so-space-4);
    outline: none;
  }
  .list-pane > .day-head:first-of-type {
    margin-top: 0;
  }
  .alerts-in-list {
    gap: var(--so-space-2);
  }
  .map-pane {
    --map-radius: var(--so-item-radius);
    isolation: isolate;
    min-height: 0;
    padding: 0 0 var(--so-space-3);
  }
  .foot p,
  .foot ul {
    margin: 0 0 var(--so-space-2);
    padding: 0 var(--so-space-3);
    list-style: none;
  }
  .foot li {
    margin: 0;
    list-style: none;
  }
  .phone-search,
  .phone-foot,
  .dock,
  .tabbar {
    display: none;
  }
  @media (min-width: 1600px) {
    .stage {
      grid-template-columns: 28rem minmax(0, 1fr) 22rem;
    }
  }

  /* ---- スマホの形 (`<html data-phone>`) ---- */
  :global(:where(html[data-phone])) .shell {
    --so-tabbar: calc(4rem + 0.5rem + env(safe-area-inset-bottom));
    --dock-h: 2.75rem;
  }
  :global(:where(html[data-phone])) .navbar,
  :global(:where(html[data-phone])) .side-panel {
    display: none;
  }
  :global(:where(html[data-phone])) .stage {
    position: relative;
    display: block;
  }
  :global(:where(html[data-phone])) .map-pane {
    --map-radius: 0;
    --map-bottom: calc(
      var(--so-tabbar) + var(--so-dock-gap) + var(--dock-h) + var(--so-space-1)
    );
    position: absolute;
    inset: 0;
    padding: 0;
  }
  /* 一覧は地図の上に重ねる面。地図のタブでは透明にして下へずらし、押せなくする (透明度と transform だけで動かす) */
  :global(:where(html[data-phone])) .list-pane {
    position: absolute;
    inset: 0;
    z-index: 1;
    padding: calc(env(safe-area-inset-top) + var(--so-space-3))
      var(--so-space-3)
      calc(var(--so-tabbar) + var(--dock-h) + var(--so-space-5));
    background: var(--so-bg);
    transition:
      opacity var(--so-duration-enter) var(--so-ease),
      transform var(--so-duration-enter) var(--so-ease-spring),
      visibility var(--so-duration-enter) allow-discrete;
  }
  :global(:where(html[data-phone])) .shell[data-view="map"] .list-pane {
    visibility: hidden;
    opacity: 0;
    transform: translateY(0.5rem);
    transition-duration: var(--so-duration-exit);
    transition-timing-function: var(--so-ease-exit);
  }
  :global(:where(html[data-phone])) .phone-search {
    display: block;
  }
  :global(:where(html[data-phone])) .phone-foot {
    display: block;
    margin-top: var(--so-space-4);
  }

  /* dock (一覧の種類と「⋯」)。下のタブから `--so-dock-gap` 上のカプセル */
  :global(:where(html[data-phone])) .dock {
    position: fixed;
    inset-inline: var(--so-dock-inset);
    z-index: var(--so-z-dock);
    display: flex;
    align-items: center;
    gap: var(--so-space-1);
    bottom: calc(var(--so-tabbar) + var(--so-dock-gap));
    height: var(--dock-h);
    padding-inline: var(--so-space-2) var(--so-space-1);
    border-radius: var(--so-radius-full);
    background: var(--so-float);
    box-shadow: var(--so-shadow-pop);
    transition: transform var(--so-duration-move) var(--so-ease-spring);
  }
  :global(:where(html[data-phone]))
    .shell[data-retract]
    .dock:not(:has(:focus-visible)) {
    transform: translateY(calc(var(--so-tabbar) + var(--so-dock-gap) + 100%));
  }
  .dock-quake {
    display: flex;
    flex: 1 1 0%;
    align-items: center;
    gap: var(--so-space-2);
    min-width: 0;
    padding-inline: var(--so-space-1);
    color: var(--so-fg);
    font-size: var(--so-text-sm);
    text-decoration: none;
  }
  .dock-more {
    flex-shrink: 0;
  }
  .dock-more.warn {
    color: var(--so-warn-text);
  }
  :global(.menu.dock-menu) {
    width: min(22rem, calc(100vw - 2 * var(--so-dock-inset)));
  }

  /* 下のタブ (いつも浮いた操作の層。denpa と同じ形) */
  :global(:where(html[data-phone])) .tabbar {
    position: fixed;
    inset: auto var(--so-dock-inset)
      calc(var(--so-space-2) + env(safe-area-inset-bottom));
    z-index: var(--so-z-header);
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    padding: var(--so-space-1);
    border-radius: 2rem;
    background: var(--so-float);
    box-shadow: var(--so-shadow-pop);
    transition: transform var(--so-duration-move) var(--so-ease-spring);
  }
  :global(:where(html[data-phone]))
    .shell[data-retract]
    .tabbar:not(:has(:focus-visible)) {
    transform: translateY(calc(100% + 0.5rem + env(safe-area-inset-bottom)));
  }
  .tabbar .tab,
  .tab-more :global(.tab) {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.125rem;
    width: 100%;
    min-height: 3.5rem;
    margin: 0;
    padding: var(--so-space-1) 0;
    border: 0;
    border-radius: 1.75rem;
    background: transparent;
    box-shadow: none;
    color: inherit;
    font-size: var(--so-text-2xs);
    font-weight: var(--so-weight);
    line-height: 1.2;
    white-space: nowrap;
  }
  @media (hover: hover) {
    .tabbar .tab:hover,
    .tab-more :global(.tab:is(:hover, [aria-expanded="true"])) {
      background: var(--so-hover-soft);
    }
  }
  .tab-more {
    display: flex;
  }
  /* 選んでいるタブは主の色の太字と、字の幅いっぱいの下線 */
  .tabbar .tab[aria-current="page"] {
    color: var(--so-primary-text);
    font-weight: var(--so-weight-bold);
  }
  .tabbar .tab > span {
    position: relative;
  }
  .tabbar .tab[aria-current="page"] > span::after {
    content: "";
    position: absolute;
    inset-inline: 0;
    top: calc(100% + 0.125rem);
    height: var(--so-mark);
    border-radius: var(--so-mark);
    background: var(--pico-primary);
  }
  @media (min-width: 640px) {
    .tabbar .tab,
    .tab-more :global(.tab) {
      font-size: var(--so-text-xs);
    }
  }
</style>
