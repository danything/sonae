<script lang="ts">
  import { browser } from "$app/env";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { tick, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import Activity from "~icons/lucide/activity";
  import Bell from "~icons/lucide/bell";
  import CalendarDays from "~icons/lucide/calendar-days";
  import Ellipsis from "~icons/lucide/ellipsis";
  import ExternalLink from "~icons/lucide/external-link";
  import Info from "~icons/lucide/info";
  import List from "~icons/lucide/list";
  import MapIcon from "~icons/lucide/map";
  import Square from "~icons/lucide/square";
  import TriangleAlert from "~icons/lucide/triangle-alert";
  import VolumeX from "~icons/lucide/volume-x";

  import { mutedText } from "#lib/alert.ts";
  import { alerter } from "#lib/alerter.svelte.ts";
  import {
    followsEew,
    isGrave,
    openHref,
    planOpen,
    targetOf,
  } from "#lib/auto-open.ts";
  import AboutDialog from "#lib/components/AboutDialog.svelte";
  import Calendar from "#lib/components/Calendar.svelte";
  import AdvisoryDetail from "#lib/components/detail/AdvisoryDetail.svelte";
  import DetailBar from "#lib/components/detail/DetailBar.svelte";
  import EewDetail from "#lib/components/detail/EewDetail.svelte";
  import ForeignDetail from "#lib/components/detail/ForeignDetail.svelte";
  import QuakeDetail from "#lib/components/detail/QuakeDetail.svelte";
  import TsunamiDetail from "#lib/components/detail/TsunamiDetail.svelte";
  import VolcanoDetail from "#lib/components/detail/VolcanoDetail.svelte";
  import WarningDetail from "#lib/components/detail/WarningDetail.svelte";
  import WeatherDetail from "#lib/components/detail/WeatherDetail.svelte";
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
  import VolcanoLevel from "#lib/components/VolcanoLevel.svelte";
  import WarningLevel from "#lib/components/WarningLevel.svelte";
  import { troubleLabel } from "#lib/connection.ts";
  import { activeEews } from "#lib/eew.ts";
  import {
    depthText,
    FOREIGN_SOURCE_SHORT,
    jst,
    jstClock,
    jstTime,
    kindText,
    magnitudeText,
    placeName,
    quakeName,
    sourceInTrouble,
    STATUS_LABEL,
    volcanoKindText,
    weatherTitle,
  } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import {
    type Advisory,
    type Eew,
    type ForeignQuake,
    isExpired,
    isPinnedAdvisory,
    isTsunamiActive,
    isTsunamiWarning,
    isUrgentAdvisory,
    type OfficeWarnings,
    type Quake,
    type Tsunami,
    tsunamiGradeLabel,
    tsunamiTop,
    type Volcano,
    VOLCANO_RESIDENTIAL,
    volcanoTop,
    type WarningLevel as Level,
    warningsByOffice,
    WEATHER_INFO_LABEL,
    type WeatherInfo,
  } from "#lib/model.ts";
  import { KMONI_URL, NOTICE, SHORT_CREDIT } from "#lib/notice.ts";
  import { PHONE_FORM } from "#lib/phone-form.ts";
  import type { Place } from "#lib/places.ts";
  import {
    applyTheme,
    readPref,
    removePref,
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
    newestFirst,
    OFFICE_PREFIX,
    pickOnly,
    pinFirst,
    readOnly,
    readView,
    selectHref,
    UNSELECT,
    viewHref,
  } from "#lib/view.ts";

  /**
   * **sonae の画面はこれ 1 つ** (docs/ui.md)。地図が主で、一覧と詳しい内容を同じ画面に置く。
   *
   * - 広い形 (1000px から): 上に全幅のヘッダー (左にロゴ、真ん中に地名で絞る欄、右に字だけのナビ)。
   *   その下は 地図 | 一覧の列 の 2 列。列は右の 1 本だけにして地図を広く取る (denpa の観る画面の右の列と同じ置き方)。
   *   列の上に種類で絞るチップと日付のカレンダー (メニュー) の 1 行、その下に一覧か、選んだときは詳しい内容
   * - スマホの形: ヘッダーを出さず、地図を画面いっぱいに。一覧は地図の上に重ねる面で、下のタブ (地図・一覧・通知・強震モニタ・その他) で切り替える。
   *   下のタブのすぐ上に操作の 1 行 (dock。一覧のタブでは種類で絞るチップ、地図のタブでは選んでいるもの)。一覧を下へ読むと、下のタブと dock は引っ込む
   *
   * 一覧は全部の種類を新しい順に 1 本に並べる。チップで全部か 1 つの種類を出し、端末に覚える。
   * いま出ている緊急地震速報・大津波警報・津波警報・気象の特別警報は、チップにかかわらず一覧の先頭に出す
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
  /**
   * 緊急地震速報。訓練・試験を出していないとき (既定。`SONAE_TRAINING=on` で出す) は、
   * SSE で来たもの (通常だけ) を重ねる
   */
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
  const volcanoes = $derived(
    snap.volcanoes.filter((x) =>
      matches(
        query,
        x.title,
        x.headline,
        ...x.volcanoes.map((a) => a.name),
        ...x.cities,
      ),
    ),
  );
  const foreigns = $derived(
    snap.foreignQuakes.filter((x) =>
      matches(query, x.place, ...x.reports.map((r) => r.place)),
    ),
  );
  const infos = $derived(
    snap.advisories.filter((a) =>
      matches(query, a.title, a.headline, a.serialName, a.text),
    ),
  );
  /** 府県予報区ごとの、いま出ている気象警報・注意報 */
  const allOffices = $derived(warningsByOffice(snap.warnings));
  const offices = $derived(
    allOffices.filter((o) =>
      matches(
        query,
        o.office.name,
        ...o.kinds.map((k) => k.name),
        ...o.kinds.flatMap((k) => k.areas.map((a) => a.name)),
      ),
    ),
  );
  /** 気象の報。台風は報が数時間ごとに出るので、台風ごとにいちばん新しい報だけを並べる */
  const weathers = $derived.by(() => {
    const seen = new Set<string>();
    return snap.weatherInfos.filter((x) => {
      if (x.kind === "typhoon") {
        if (seen.has(x.series)) return false;
        seen.add(x.series);
      }
      return matches(
        query,
        x.title,
        x.headline,
        x.kindName,
        ...x.areas.map((a) => a.name),
      );
    });
  });
  const counts = $derived<Record<Kind, number>>({
    quake: quakes.length,
    tsunami: tsunamis.length,
    eew: eews.length,
    volcano: volcanoes.length,
    weather: offices.length + weathers.length,
    info: infos.length,
    foreign: foreigns.length,
  });

  const quakeTime = (q: Quake) => q.originTime ?? q.updatedAt;

  // ---- 種類で絞るチップ (全部か 1 つの種類。端末に覚える。既定は全部出す) ----
  /** 出している 1 つの種類 (null は全部) */
  let only = $state<Kind | null>(null);
  $effect.pre(() => {
    only = readOnly(readPref("list.only"));
    // 前の形 (隠す種類の配列) と、前の地図の層のオン・オフ (層はいつも全部出す) は読まずに消す
    removePref("list.hidden");
    removePref("map.layers");
  });
  const shownKind = (k: Kind) => only === null || only === k;
  /** チップを押した (null は「すべて」) */
  function pickKind(k: Kind | null) {
    only = pickOnly(only, k);
    if (only) writePref("list.only", only);
    else removePref("list.only");
    // 詳しい内容を見ているときは、絞った一覧へ戻る
    if (v.selected) void goto(backHref, { reset: false });
  }
  const allCount = $derived(KINDS.reduce((n, k) => n + counts[k], 0));

  /**
   * 一覧の 1 本の並び。種類をまたいで時刻の新しい順に並べ、日付の見出しで束ねる。
   * 府県予報区の警報・注意報は、その府県予報区のいちばん新しい報の時刻に並ぶ (出ている間は残る)
   */
  const timeline = $derived.by(() => {
    const items: { at: string; row: () => RowData }[] = [];
    function add<T>(
      kind: Kind,
      list: T[],
      at: (x: T) => string | undefined,
      row: (x: T) => RowData,
    ) {
      if (!shownKind(kind)) return;
      // 行の鍵には種類を付ける。種類が違えば同じ id があり、同じ日に並ぶと鍵がぶつかって画面ごと落ちる
      // (地震と、その地震の津波は、どちらも id が地震識別番号)
      for (const x of list)
        items.push({
          at: at(x) ?? "",
          row: () => {
            const r = row(x);
            return { ...r, key: `${kind}:${r.key}` };
          },
        });
    }
    add("quake", quakes, quakeTime, quakeRow);
    add("tsunami", tsunamis, (t) => t.issuedAt, tsunamiRow);
    add("eew", eews, (e) => e.issuedAt, eewRow);
    add("volcano", volcanoes, (x) => x.eventTime ?? x.reportedAt, volcanoRow);
    add("weather", offices, (o) => o.reportedAt, officeRow);
    add("weather", weathers, (x) => x.reportedAt, weatherRow);
    add("foreign", foreigns, (x) => x.originTime, foreignRow);
    add("info", infos, (a) => a.reportedAt, infoRow);
    return groupByDay(
      newestFirst(items, (x) => x.at),
      (x) => x.at,
    ).map((g) => ({
      day: g.day,
      rows: g.items.map((x) => x.row()),
    }));
  });
  function foreignRow(x: ForeignQuake): RowData {
    return {
      key: x.id,
      href: selectHref(params, "foreign", x.id),
      current: v.selected?.kind === "foreign" && v.selected.id === x.id,
      time: jstTime(x.originTime),
      title: x.place || "場所は不明",
      meta: [
        "海外の地震",
        x.magnitude === undefined ? "" : `M${x.magnitude.toFixed(1)}`,
        x.depthKm === undefined ? "" : `深さ 約 ${Math.round(x.depthKm)} km`,
        x.reports.map((r) => FOREIGN_SOURCE_SHORT[r.source]).join("・"),
      ]
        .filter(Boolean)
        .join("・"),
      states: [],
    };
  }
  /** 府県予報区の警報・注意報の行。いちばん高い段のラベルと、出ている種類の名前 */
  function officeRow(o: OfficeWarnings): RowData {
    const id = `${OFFICE_PREFIX}${o.office.code}`;
    return {
      key: id,
      href: selectHref(params, "weather", id),
      current: v.selected?.kind === "weather" && v.selected.id === id,
      time: jstTime(o.reportedAt),
      title: `${o.office.name}の警報・注意報`,
      meta: o.kinds.map((k) => kindText(k.name)).join("・"),
      warning: { level: o.top },
      states: [],
    };
  }
  function weatherRow(x: WeatherInfo): RowData {
    const expired = isExpired(x, live.now);
    return {
      key: x.id,
      href: selectHref(params, "weather", x.id),
      current: v.selected?.kind === "weather" && v.selected.id === x.id,
      time: jstTime(x.reportedAt),
      title: weatherTitle(x),
      meta: [
        WEATHER_INFO_LABEL[x.kind],
        x.typhoon?.remark ?? "",
        x.kind === "bosai" ? x.kindName : "",
        x.headline.replace(/\s+/g, " ").trim(),
      ]
        .filter(Boolean)
        .join("・"),
      warning:
        x.level !== undefined && x.level > 0
          ? { level: x.level, label: kindText(x.kindName ?? "") || undefined }
          : undefined,
      states: [
        ...(x.cancelled ? [{ label: "取消", tone: "error" as const }] : []),
        ...(expired ? [{ label: "有効期限切れ", tone: "" as const }] : []),
      ],
    };
  }
  function infoRow(a: Advisory): RowData {
    return {
      key: a.id,
      href: selectHref(params, "info", a.id),
      current: v.selected?.kind === "info" && v.selected.id === a.id,
      time: jstTime(a.reportedAt),
      title: a.serialName ? `${a.title} (${a.serialName})` : a.title,
      meta: a.headline,
      states: a.cancelled ? [{ label: "取消", tone: "error" }] : [],
    };
  }

  interface RowData {
    key: string;
    href: string;
    current: boolean;
    time: string;
    title: string;
    meta: string;
    quake?: Quake;
    grade?: Tsunami["areas"][number]["grade"];
    /** 火山の警戒の段のラベル */
    volcano?: { level: number | undefined; label: string };
    /** 気象警報・注意報・洪水予報の段のラベル */
    warning?: { level: Level; label?: string };
    states: { label: string; tone: "error" | "info" | "" }[];
  }
  function volcanoRow(x: Volcano): RowData {
    const flash = x.code === "VFVO56";
    const first = x.volcanoes[0];
    const top = volcanoTop(x);
    return {
      key: x.id,
      href: selectHref(params, "volcano", x.id),
      current: v.selected?.kind === "volcano" && v.selected.id === x.id,
      time: jstTime(x.eventTime ?? x.reportedAt),
      title: flash
        ? `${x.volcanoes.map((a) => a.name).join("・")} 噴火速報`
        : x.title,
      meta: flash
        ? x.headline.replace(/[＜＞]/g, " ").trim()
        : [first?.condition, x.cities.slice(0, 4).join("、")]
            .filter(Boolean)
            .join("・"),
      volcano: flash
        ? { level: 5, label: "噴火速報" }
        : {
            level: top || undefined,
            label: first ? volcanoKindText(first.kind) : "火山",
          },
      states: x.cancelled ? [{ label: "取消", tone: "error" }] : [],
    };
  }
  /** 長周期地震動に関する観測情報 (VXSE62) を地震識別番号で引く (P2P で先に受けた地震は id が番号ではないので、id では引かない) */
  const longPeriodOf = (q: Quake | null | undefined) =>
    q?.eventId
      ? snap.longPeriods.find(
          (lp) => lp.eventId === q.eventId && lp.status === q.status,
        )
      : undefined;
  /** 一覧の行の補足。長周期地震動階級 1 以上を観測した地震だけ */
  function lgText(q: Quake): string {
    const lp = longPeriodOf(q);
    return lp && !lp.cancelled && lp.maxLg !== "0"
      ? `長周期地震動階級${lp.maxLg}`
      : "";
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
        lgText(q),
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
        e.kind === "warning" ? "緊急地震速報 (警報)" : "緊急地震速報 (予報)",
        `第 ${e.serial} 報${e.final ? " (最終報)" : ""}`,
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
      (a) =>
        isPinnedAdvisory(a) &&
        !a.cancelled &&
        Date.parse(a.reportedAt) > live.now - WEEK,
    ),
  );
  /** いま出ている緊急地震速報 (取消・最終報の後も 3 分は残る。訓練・試験は除く) */
  const liveEews = $derived(browser ? activeEews(snap.eews, live.now) : []);
  /** 火山: 1 日以内の噴火速報と、いま噴火警報 (レベル 4・5 相当) が出ている火山 */
  const DAY = 24 * 60 * 60_000;
  const volcanoAlerts = $derived([
    ...snap.volcanoes.filter(
      (x) =>
        x.code === "VFVO56" &&
        !x.cancelled &&
        Date.parse(x.eventTime ?? x.reportedAt) > live.now - DAY,
    ),
    ...snap.volcanoLevels.filter((x) => volcanoTop(x) >= VOLCANO_RESIDENTIAL),
  ]);
  /** 気象: いま特別警報 (レベル 5) が出ている府県予報区。チップにかかわらず一覧の先頭に出す */
  const specialOffices = $derived(allOffices.filter((o) => o.top === 5));
  /**
   * 一覧の先頭に出すもの。いま出ている緊急地震速報・大津波警報・津波警報・特別警報はチップにかかわらず出し
   * (身を守る動きにつなげるもの)、ほかの津波・噴火・お知らせはその種類を出しているときだけ
   */
  const pinnedEews = $derived(liveEews.filter((e) => !e.cancelled));
  const pinnedTsunamis = $derived(activeTsunamis.filter(isTsunamiWarning));
  const otherTsunamis = $derived(
    shownKind("tsunami")
      ? activeTsunamis.filter((t) => !isTsunamiWarning(t))
      : [],
  );
  const shownVolcanoAlerts = $derived(
    shownKind("volcano") ? volcanoAlerts : [],
  );
  const shownAdvisories = $derived(shownKind("info") ? advisories : []);
  const hasPinned = $derived(
    pinnedEews.length +
      pinnedTsunamis.length +
      specialOffices.length +
      otherTsunamis.length +
      shownVolcanoAlerts.length +
      shownAdvisories.length >
      0,
  );

  // ---- 選んだもの (SSE で続報が来たら差し替える) ----
  const selQuake = $derived(
    v.selected?.kind === "quake"
      ? (snap.quakes.find((q) => q.id === v.selected?.id) ?? data.quake)
      : null,
  );
  const selLongPeriod = $derived(
    longPeriodOf(selQuake) ?? (selQuake ? data.longPeriod : null),
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
  const selVolcano = $derived(
    v.selected?.kind === "volcano"
      ? (snap.volcanoes.find((x) => x.id === v.selected?.id) ?? data.volcano)
      : null,
  );
  const selForeign = $derived(
    v.selected?.kind === "foreign"
      ? (snap.foreignQuakes.find((x) => x.id === v.selected?.id) ??
          data.foreign)
      : null,
  );
  const selInfo = $derived(
    v.selected?.kind === "info"
      ? (snap.advisories.find((a) => a.id === v.selected?.id) ?? data.advisory)
      : null,
  );
  /** 選んだ府県予報区の警報・注意報 (`w=office-<コード>`)。解除されて無くなったら null */
  const selOffice = $derived(
    v.selected?.kind === "weather" && v.selected.id.startsWith(OFFICE_PREFIX)
      ? (allOffices.find(
          (o) => `${OFFICE_PREFIX}${o.office.code}` === v.selected?.id,
        ) ?? null)
      : null,
  );
  const selWeather = $derived(
    v.selected?.kind === "weather" && !v.selected.id.startsWith(OFFICE_PREFIX)
      ? (snap.weatherInfos.find((x) => x.id === v.selected?.id) ??
          data.weatherInfo)
      : null,
  );
  const backHref = $derived(viewHref(params, { ...UNSELECT }));

  // ---- 地図 ----
  // 地震 (震央の ×・震度の塗りと数字・長周期地震動の枠) は、選んだときだけ出す。何も選んでいないときに
  // いちばん新しい地震を出すと、いま起きていることのように見えるため (持ち主の声「詳細開いてないときは
  // 地震情報表示しなくていいかも」)。いま出ている緊急地震速報・津波・特別警報と気象の警報・注意報の塗りは、
  // 選んでいなくても出す (docs/map.md の「何も選んでいないとき」)
  const mapQuake = $derived(selQuake ?? undefined);
  const mapLongPeriod = $derived(selQuake ? selLongPeriod : null);
  const mapTsunamis = $derived(selTsunami ? [selTsunami] : activeTsunamis);
  /** 緊急地震速報は、出ている間はほかのものを選んでいても出す (選んだ前の報は、それに足す) */
  const mapEews = $derived(
    selEew && !liveEews.some((e) => e.eventId === selEew.eventId)
      ? [selEew, ...liveEews]
      : liveEews,
  );
  /** スマホの形の地図のタブで、何も選んでいないときに dock に出すもの (命に関わる、いま出ているもの) */
  const dockPin = $derived(
    pinFirst(
      pinnedEews,
      pinnedTsunamis,
      specialOffices.map((o) => o.office),
    ),
  );
  // ---- スマホの形: 地図と一覧の切り替え (選んだもので開いたときは一覧) ----
  // svelte-ignore state_referenced_locally
  let tab = $state<"map" | "list">(v.selected ? "list" : "map");

  /** 検索の欄で選んだ場所 (地図をそこへ寄せて印を置く。`n` は同じ場所を選び直したときも寄せ直すため) */
  let found = $state<{ place: Place; n: number } | null>(null);
  function pickPlace(place: Place): void {
    found = { place, n: (found?.n ?? 0) + 1 };
    // スマホの形は地図のタブへ移る
    if (phone.current) tab = "map";
  }
  // 欄を空にしたら、選んだ場所の印も消す
  $effect(() => {
    if (query.trim() === "") found = null;
  });
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
    new Map(timeline.map((g) => [g.day, g.rows.length] as const)),
  );
  let picked = $state<string | null>(null);
  const pinned = $derived(
    selQuake
      ? dayKey(quakeTime(selQuake))
      : selTsunami
        ? dayKey(selTsunami.issuedAt)
        : selEew
          ? dayKey(selEew.issuedAt)
          : selVolcano
            ? dayKey(selVolcano.eventTime ?? selVolcano.reportedAt)
            : selOffice
              ? dayKey(selOffice.reportedAt)
              : selWeather
                ? dayKey(selWeather.reportedAt)
                : selInfo
                  ? dayKey(selInfo.reportedAt)
                  : selForeign
                    ? dayKey(selForeign.originTime)
                    : picked,
  );
  let calMenu = $state(false);
  async function pickDay(day: string) {
    picked = day;
    calMenu = false;
    if (v.selected) await goto(backHref, { reset: false });
    await tick();
    document.getElementById(`day-${day}`)?.scrollIntoView({ block: "start" });
  }

  // ---- テーマ (暗い・明るい・端末に合わせる。既定は端末に合わせる) ----
  const THEMES: { mode: ThemeMode; label: string }[] = [
    { mode: "dark", label: "暗い" },
    { mode: "light", label: "明るい" },
    { mode: "system", label: "端末に合わせる" },
  ];
  let theme = $state<ThemeMode>("system");
  $effect(() => {
    const m = document.documentElement.dataset.themeMode;
    if (m === "light" || m === "system" || m === "dark") theme = m;
  });
  function setTheme(mode: ThemeMode) {
    theme = mode;
    applyTheme(mode);
  }

  // ---- 状態 (つながっていないものがあるときだけ、ヘッダーと dock に注意の印。押すと情報源ごとの受信。
  // 設定で切ってある情報源 (オフ) は問題にしない。いつもの状態は「出典と注意」の「受信の状態」) ----
  const trouble = $derived(
    browser && (!live.connected || snap.statuses.some(sourceInTrouble)),
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
  let statusMenu = $state(false);

  // ---- 自動で開く (読み上げ始めた報と、出た緊急地震速報。docs/ui.md の「自動で開く」) ----
  /**
   * 自動で開いたもの。`href` は開いたリンク (いまの URL がこれと同じ間は、人がまだ動かしていない)、
   * `back` と `pushed` は自動で開く前にいた所と、履歴を積んだか (続けて開いても、初めのものを持ち続ける)。
   * `eew` は緊急地震速報を開いたときの識別番号 (出ている間が過ぎたら、元の所へ戻る)
   */
  let auto = $state<{
    href: string;
    back: string;
    pushed: boolean;
    eew?: string;
  } | null>(null);
  const here = $derived(`${page.url.pathname}${page.url.search}`);
  const autoShown = $derived(auto !== null && auto.href === here);
  /**
   * いま移っている最中の自動で開くリンク。読み上げと緊急地震速報の両方が同じ報を続けて開こうとしたとき、
   * URL が替わる前の 2 度目で履歴をもう 1 つ積まないよう、移っている間も自動で開いたものとして扱う
   */
  let opening: string | null = null;
  function autoOpen(target: NonNullable<typeof v.selected>, grave: boolean) {
    const own = autoShown || (auto !== null && opening === auto.href);
    const plan = planOpen(target, grave, {
      selected: v.selected,
      auto: own,
      holdingEew:
        selEew !== null && pinnedEews.some((e) => e.eventId === selEew.eventId),
      followsHeldEew:
        selEew !== null &&
        target.kind === "quake" &&
        snap.quakes.some((q) => q.id === target.id && followsEew(q, selEew)),
      dialog: v.about || pushOpen,
    });
    if (!plan) return;
    if (plan.closeDialog) pushOpen = false;
    const href = openHref(params, target, plan.closeDialog);
    if (opening === href) return;
    const same =
      v.selected?.kind === target.kind && v.selected.id === target.id;
    if (!same) {
      const prev = own ? auto : null;
      auto = {
        href,
        back: prev?.back ?? here,
        pushed: prev?.pushed ?? !plan.replace,
        ...(target.kind === "eew" ? { eew: target.id } : {}),
      };
    } else if (auto?.href === here) {
      // もう開いているものの上の窓を閉じただけ。自動で開いたものなら、URL が替わるので控えも合わせる。
      // 人が自分で開いていたものなら控えない (出ている間が過ぎても、窓を開き直して戻ったりしない)
      auto = { ...auto, href };
    }
    // 地図は選んだものが替わったので、いつもの決まりでその報へ寄る (スマホの形でもタブは替えない。
    // 地図のタブなら地図が寄って dock にその報が出て、一覧のタブなら詳しい内容が出る)
    opening = href;
    void goto(href, { reset: false, replace: plan.replace }).finally(() => {
      if (opening === href) opening = null;
    });
  }
  // 読み上げ始めた報 (読み上げがオンのときだけ呼ばれる)
  $effect(() => {
    alerter.onread = (n) => {
      const target = targetOf(n.url);
      if (target) autoOpen(target, isGrave(n));
    };
    return () => {
      alerter.onread = undefined;
    };
  });
  /** 開いた緊急地震速報 (識別番号と警報か予報か。予報から警報に上がったら、もう一度開く) */
  const openedEews = new Set<string>();
  // 出た緊急地震速報は、読み上げがオフでも開く (命に関わるので、人がほかのものを見ていても切り替える)
  $effect(() => {
    const fresh = pinnedEews.filter(
      (e) => !openedEews.has(`${e.eventId}:${e.kind}`),
    );
    if (fresh.length === 0) return;
    for (const e of fresh) openedEews.add(`${e.eventId}:${e.kind}`);
    // 幾つか同時に出たら、警報を先に開く (ほかは一覧の先頭に貼ってある)
    const first = fresh.find((e) => e.kind === "warning") ?? fresh[0];
    if (first)
      untrack(() => autoOpen({ kind: "eew", id: first.eventId }, true));
  });
  // 自動で開いた緊急地震速報が出ている間 (取消・最終報の後 3 分) を過ぎたら、人が動かしていなければ元の所へ戻る
  $effect(() => {
    const a = auto;
    if (!a?.eew || !autoShown) return;
    const id = a.eew;
    if (liveEews.some((e) => e.eventId === id)) return;
    untrack(() => {
      auto = null;
      if (a.pushed) history.back();
      else void goto(a.back, { reset: false, replace: true });
    });
  });

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

  /**
   * 読み上げている間の Esc で、読み上げを止める (「読み上げ中断」と同じ)。Esc を先に使うもの (メニュー・
   * 検索の候補・窓) が使ったとき (`defaultPrevented`) と、欄に打っている間・窓を開いている間は止めない
   */
  function stopShortcut(event: KeyboardEvent): void {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      !alerter.reading
    )
      return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest("input, textarea, select, dialog") !== null)
    )
      return;
    if (document.querySelector("dialog[open]") !== null) return;
    event.preventDefault();
    alerter.stopReading();
  }

  const title = $derived(
    selQuake
      ? `${quakeName(selQuake)} ${jst(quakeTime(selQuake))} - sonae`
      : selTsunami
        ? `津波 ${jst(selTsunami.issuedAt)} - sonae`
        : selEew
          ? `緊急地震速報 ${jst(selEew.issuedAt)} - sonae`
          : selVolcano
            ? `${selVolcano.title} ${jst(selVolcano.reportedAt)} - sonae`
            : selOffice
              ? `${selOffice.office.name}の警報・注意報 - sonae`
              : selWeather
                ? `${weatherTitle(selWeather)} ${jst(selWeather.reportedAt)} - sonae`
                : selInfo
                  ? `${selInfo.title} ${jst(selInfo.reportedAt)} - sonae`
                  : selForeign
                    ? `${selForeign.place} ${jst(selForeign.originTime)} - sonae`
                    : "sonae",
  );
  /** 選んだ緊急地震速報が、いま出ているもの (取消・最終報の後 3 分まで) */
  const selEewLive = $derived(
    selEew !== null && liveEews.some((e) => e.eventId === selEew.eventId),
  );
  /** スマホの形の地図のタブで、地震でないものを選んでいるときの dock の 1 行 */
  const dockText = $derived(
    selEew
      ? [
          selEew.cancelled
            ? "緊急地震速報 (取消)"
            : selEew.kind === "warning"
              ? "緊急地震速報 (警報) 強い揺れに警戒"
              : "緊急地震速報 (予報)",
          selEew.cancelled ? "" : placeName(selEew.hypocenter),
        ]
          .filter(Boolean)
          .join("・")
      : title === "sonae"
        ? "この情報はありません"
        : title.replace(/ - sonae$/, ""),
  );
  const user = $derived(data.user);
</script>

<svelte:window
  onkeydown={(event) => {
    searchShortcut(event);
    stopShortcut(event);
  }}
/>

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

{#snippet rowItem(r: RowData)}
  <!-- 状態のバッジは、あるときだけ渡す (空の入れ物が行の間隔を広げないよう) -->
  {#snippet stateTags()}
    {#each r.states as s (s.label)}
      <span class="tag {s.tone}">{s.label}</span>
    {/each}
  {/snippet}
  <li>
    <Row
      href={r.href}
      current={r.current}
      time={r.time}
      title={r.title}
      meta={r.meta}
      tags={r.states.length > 0 ? stateTags : undefined}
    >
      {#snippet lead()}
        {#if r.quake}
          <Intensity int={r.quake.maxInt} />
        {:else if r.grade}
          <Grade grade={r.grade} />
        {:else if r.volcano}
          <VolcanoLevel level={r.volcano.level} label={r.volcano.label} />
        {:else if r.warning}
          <WarningLevel level={r.warning.level} label={r.warning.label} />
        {/if}
      {/snippet}
    </Row>
  </li>
{/snippet}

{#snippet statusBody()}
  <p class="menu-head">
    {troubleLabel(live.connected)}
  </p>
  <StatusList connected={live.connected} statuses={snap.statuses} />
{/snippet}

{#snippet kindChips(where: string)}
  <!--
    種類で絞るチップ。「すべて」か 1 つの種類を出す。押すとその種類だけにし、出している種類をもう一度押すと全部に戻す
    (並びの中なので、出している印は幅いっぱいの下線と太字。✕ は置かず、全部へは先頭の「すべて」で戻る)
  -->
  <div class="chips {where}" role="group" aria-label="出す種類">
    <button
      type="button"
      class="chip"
      aria-pressed={only === null}
      onclick={() => pickKind(null)}
      data-testid="filter-all"
    >
      すべて <span class="num">{allCount}</span>
    </button>
    {#each KINDS as k (k)}
      <button
        type="button"
        class="chip"
        aria-pressed={only === k}
        onclick={() => pickKind(k)}
        data-testid="filter-{k}"
      >
        {KIND_LABEL[k]} <span class="num">{counts[k]}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet pinnedNotices()}
  <div class="alerts-in-list stack" data-testid="pinned">
    {#each pinnedEews as e (e.eventId)}
      <!-- 出ている緊急地震速報。自動で開く詳しい内容から離れても、一覧から移れるように置く -->
      <a
        class="notice warning notice-link"
        href={selectHref(params, "eew", e.eventId)}
        data-testid="pinned-eew"
      >
        <Icon icon={TriangleAlert} />
        <div>
          <p class="bold">
            {e.kind === "warning"
              ? "緊急地震速報 (警報)"
              : "緊急地震速報 (予報)"}
          </p>
          <p class="small muted">{jstClock(e.issuedAt)} 発表</p>
          <p class="small">
            {[
              placeName(e.hypocenter),
              e.kind === "warning" ? e.warnAreas.join("、") : "",
            ]
              .filter(Boolean)
              .join("・")}
          </p>
        </div>
      </a>
    {/each}
    {#each pinnedTsunamis as t (t.id)}
      <TsunamiSummary tsunami={t} href={selectHref(params, "tsunami", t.id)} />
    {/each}
    {#each specialOffices as o (o.office.code)}
      <!-- 気象の特別警報 (レベル 5) -->
      <a
        class="notice warning notice-link"
        href={selectHref(params, "weather", `${OFFICE_PREFIX}${o.office.code}`)}
        data-testid="special-warning"
      >
        <Icon icon={TriangleAlert} />
        <div>
          <p class="bold">{o.office.name}に特別警報</p>
          <p class="small muted">{jst(o.reportedAt)} 更新</p>
          <p class="special-kinds">
            {#each o.kinds.filter((k) => k.level === 5) as k (k.code)}
              <WarningLevel level={5} label={kindText(k.name)} />
            {/each}
          </p>
          <p class="small">
            {o.kinds
              .filter((k) => k.level === 5)
              .flatMap((k) => k.areas.map((a) => a.name))
              .filter((n, i, all) => all.indexOf(n) === i)
              .join("、")}
          </p>
        </div>
      </a>
    {/each}
    {#each otherTsunamis as t (t.id)}
      <TsunamiSummary tsunami={t} href={selectHref(params, "tsunami", t.id)} />
    {/each}
    {#each shownVolcanoAlerts as x (x.id)}
      <a
        class="notice warning notice-link"
        href={selectHref(params, "volcano", x.id)}
      >
        <Icon icon={TriangleAlert} />
        <div>
          <p class="bold">
            {x.code === "VFVO56"
              ? `噴火速報 ${x.volcanoes.map((a) => a.name).join("・")}`
              : x.title}
          </p>
          <p class="small muted">{jst(x.reportedAt)} 発表</p>
          <p class="small">{x.headline}</p>
        </div>
      </a>
    {/each}
    {#each shownAdvisories as a (a.id)}
      <a
        class="notice notice-link"
        class:warning={isUrgentAdvisory(a)}
        class:info={!isUrgentAdvisory(a)}
        href={selectHref(params, "info", a.id)}
      >
        <Icon icon={isUrgentAdvisory(a) ? TriangleAlert : Info} />
        <div>
          <p class="bold">{a.title}</p>
          <p class="small muted">{jst(a.reportedAt)} 発表</p>
          <p class="small">{a.headline}</p>
        </div>
      </a>
    {/each}
  </div>
{/snippet}

<div
  class="shell"
  data-view={tab}
  data-sveltekit-reset="false"
  data-retract={retract ? "" : undefined}
  data-testid="shell"
>
  <a class="skip" href="#list">一覧へ移動</a>

  <!-- 広い形のヘッダー (スマホの形では出さない) -->
  <header class="navbar">
    <a class="logo" href="/" aria-label="sonae (一覧へ)">
      {@render logo()}
      <span>sonae</span>
    </a>
    <div class="header-search">
      <SearchField bind:value={query} onplace={pickPlace} />
    </div>
    <nav class="actions" aria-label="メニュー">
      {#if trouble}
        <!-- 受信に問題があるときだけの注意の印。押すと情報源ごとの受信をメニューの箱で出す -->
        <Menu bind:open={statusMenu} align="end" class="status-menu">
          {#snippet trigger(props)}
            <button
              {...props}
              type="button"
              class="ghost small trouble"
              data-testid="trouble"
            >
              <Icon icon={TriangleAlert} size={1} />
              {troubleLabel(live.connected)}
            </button>
          {/snippet}
          {@render statusBody()}
        </Menu>
      {/if}
      <a class="button ghost small" href={aboutHref}>出典と注意</a>
      {#if user}
        <button
          type="button"
          class="ghost small"
          aria-haspopup="dialog"
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

  {#if alerter.blocked}
    {@const m = mutedText(
      {
        sound: alerter.settings.sound,
        speech: alerter.settings.speech && alerter.canSpeak,
      },
      alerter.notifying,
    )}
    <!--
      音か読み上げがオンなのに、ブラウザが音を止めている (最初の操作の前・再生を断られた)。
      ヘッダーのすぐ下 (スマホの形は画面の上の端) の帯で、何が止まっていて何は届くかを言う。帯のどこを押しても鳴らせるようになる
    -->
    <button
      type="button"
      class="mute-band"
      onclick={() => alerter.unlock()}
      data-testid="sound-blocked"
    >
      <Icon icon={VolumeX} size={1.25} />
      <span class="mute-text">
        <span class="mute-head">{m.head}</span>
        <span class="mute-body">{m.body}</span>
      </span>
      <span class="mute-action">音を出す</span>
    </button>
  {/if}

  {#if alerter.reading}
    <!--
      読み上げている間だけ、地図の左下 (スマホの形は dock のすぐ上の左) に浮かせる。押すといまの読み上げを止める
      (音と読み上げの設定は変えない)。Esc でも止まる
    -->
    <button
      type="button"
      class="small speech-stop"
      onclick={() => alerter.stopReading()}
      aria-keyshortcuts="Escape"
      title="読み上げ中断 (Esc)"
      data-testid="speech-stop"
    >
      <Icon icon={Square} size={1} />
      読み上げ中断
    </button>
  {/if}

  <main class="stage">
    <div class="list-col">
      <!-- 広い形: 種類で絞るチップと、日付で移るカレンダー (スマホの形では dock のチップ) -->
      <div class="list-bar" role="toolbar" aria-label="出す種類と日付">
        {@render kindChips("bar")}
        <Menu bind:open={calMenu} align="end" nav class="cal-menu">
          {#snippet trigger(props)}
            <button
              {...props}
              type="button"
              class="ghost icon small"
              aria-label="日付で移る"
              title="日付で移る"
              data-testid="calendar-open"
            >
              <Icon icon={CalendarDays} />
            </button>
          {/snippet}
          <Calendar {marks} {today} {pinned} onpick={pickDay} />
        </Menu>
      </div>
      <section
        id="list"
        class="list-pane"
        aria-label={v.selected ? "詳しい内容" : "一覧"}
        bind:this={listBox}
        onscroll={onListScroll}
        inert={phone.current && tab === "map" ? true : undefined}
        tabindex="-1"
      >
        <div class="phone-search">
          <SearchField bind:value={query} onplace={pickPlace} />
        </div>

        {#if v.selected}
          <DetailBar {backHref} onmap={() => (tab = "map")} />
          {#if selQuake}
            <QuakeDetail q={selQuake} lp={selLongPeriod} />
          {:else if selTsunami}
            <TsunamiDetail t={selTsunami} now={live.now} />
          {:else if selEew}
            <EewDetail e={selEew} active={selEewLive} />
          {:else if selVolcano}
            <VolcanoDetail v={selVolcano} />
          {:else if selForeign}
            <ForeignDetail q={selForeign} />
          {:else if selInfo}
            <AdvisoryDetail a={selInfo} />
          {:else if selOffice}
            <WarningDetail o={selOffice} />
          {:else if selWeather}
            <WeatherDetail w={selWeather} now={live.now} />
          {:else}
            <div class="empty-state">
              <p class="bold">この情報はありません</p>
              <p class="small muted">
                保存していないか、取り消されたものです。一覧から選んでください。
              </p>
            </div>
          {/if}
        {:else}
          {#if hasPinned}
            {@render pinnedNotices()}
          {/if}

          <h1 class="visually-hidden">一覧</h1>
          {#each timeline as g (g.day)}
            <h2 class="day-head" id="day-{g.day}">
              <span class="day-head-chip">{dayLabel(g.day)}</span>
            </h2>
            <ol class="item-list">
              {#each g.rows as r (r.key)}
                {@render rowItem(r)}
              {/each}
            </ol>
          {:else}
            <div class="empty-state">
              {#if query.trim() !== "" || only !== null}
                <p class="bold">当てはまるものはありません</p>
              {:else}
                <p class="bold">まだ情報を受けていません</p>
                <p class="small muted">
                  受けると、ここに新しい順で並びます。受信に問題があるときは、ヘッダー
                  (スマホの形は下の操作の 1 行) に注意の印が出ます。
                </p>
              {/if}
            </div>
          {/each}
        {/if}

        <!-- 注意文と短い出典 (docs/design.md の 5 章)。どちらの形も一覧のいちばん下。出典の全文は「出典と注意」の窓 -->
        <footer class="foot tiny muted">
          <p>{NOTICE}</p>
          <p>
            {SHORT_CREDIT}。全文は<a href={aboutHref} data-testid="foot-credits"
              >「出典と注意」</a
            >にあります。
          </p>
        </footer>
      </section>
    </div>

    <div class="map-pane">
      <QuakeMap
        quake={mapQuake}
        longPeriod={mapLongPeriod}
        quakes={snap.quakes}
        tsunamis={mapTsunamis}
        eews={mapEews}
        volcanoes={snap.volcanoLevels}
        volcano={selVolcano}
        foreign={snap.foreignQuakes}
        foreignQuake={selForeign}
        rtsStations={live.rtsStations}
        rts={live.rts}
        seisStations={live.seisStations}
        seis={live.seis}
        warnings={snap.warnings}
        office={selOffice?.office.code ?? null}
        officeHref={(code) =>
          selectHref(params, "weather", `${OFFICE_PREFIX}${code}`)}
        onoffice={() => (tab = "list")}
        {aboutHref}
        shown={!phone.current || tab === "map"}
        {found}
        selected={v.selected !== null}
      />
    </div>
  </main>

  <!-- スマホの形: 下のタブのすぐ上の操作の 1 行 -->
  <div
    class="dock"
    role="toolbar"
    aria-label="出す種類と、地図に出しているもの"
  >
    {#if tab === "list"}
      {@render kindChips("scroll")}
    {:else if v.selected && !selQuake}
      <!--
        地震でないものを選んでいる (自動で開いた緊急地震速報など)。地図はそれに寄っているので、dock にもそれを出す。
        押すと一覧のタブの詳しい内容へ。いま出ている緊急地震速報 (警報) は状態の赤で塗る
      -->
      <button
        type="button"
        class="dock-quake dock-selected"
        class:eew-warning={selEewLive &&
          !selEew?.cancelled &&
          selEew?.kind === "warning"}
        class:eew-forecast={selEewLive &&
          (selEew?.cancelled || selEew?.kind !== "warning")}
        onclick={() => (tab = "list")}
        data-testid="dock-selected"
      >
        {#if selEew}<Icon icon={TriangleAlert} size={1} />{/if}
        <span class="truncate">{dockText}</span>
      </button>
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
    {:else if dockPin}
      <!-- 何も選んでいないが、命に関わるものが出ている (一覧の先頭にいつも貼るもののいちばん上)。押すとその詳しい内容へ -->
      <a
        class="dock-quake dock-selected"
        class:eew-warning={dockPin.red}
        class:eew-forecast={!dockPin.red}
        href={selectHref(params, dockPin.kind, dockPin.id)}
        onclick={() => (tab = "list")}
        data-testid="dock-pin"
      >
        <Icon icon={TriangleAlert} size={1} />
        <span class="truncate">{dockPin.label}</span>
      </a>
    {:else}
      <!-- 何も選んでいない。地図に地震は出さないので、選び方を言う (dock の高さは変えない) -->
      <span class="dock-quake muted small" data-testid="dock-hint"
        >一覧から選ぶと、地図とここに出ます</span
      >
    {/if}
    {#if trouble}
      <!-- 受信に問題があるときだけの注意の印。押すと情報源ごとの受信 -->
      <Menu bind:open={dockMenu} side="top" align="end" class="dock-menu">
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="ghost icon small dock-more warn"
            aria-label={troubleLabel(live.connected, true)}
            data-testid="dock-trouble"
          >
            <Icon icon={TriangleAlert} />
          </button>
        {/snippet}
        {@render statusBody()}
      </Menu>
    {/if}
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
    <!--
      よく使うものはタブに出す (docs/ui.md の「スマホの形」)。通知は条件を見直し・試しに送る入口、
      強震モニタは揺れたときにすぐ開きたい外のページ (新しいタブ)。タブに出したものは「その他」に入れない
    -->
    {#if user}
      <button
        type="button"
        class="tab"
        aria-haspopup="dialog"
        onclick={() => (pushOpen = true)}
        data-testid="tab-push"
      >
        <Icon icon={Bell} />
        <span>通知</span>
      </button>
    {/if}
    <a
      class="tab"
      href={KMONI_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="強震モニタ (防災科研のページを新しいタブで開く)"
      data-testid="tab-kmoni"
    >
      <Icon icon={Activity} />
      <span>強震モニタ</span>
    </a>
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
        <div class="menu-gap"></div>
        {@render themeItems()}
        {@render accountItems()}
      </Menu>
    </div>
  </nav>

  <AboutDialog
    open={v.about}
    onclose={closeAbout}
    connected={live.connected}
    statuses={snap.statuses}
  />
  {#if user}
    <PushSettings bind:open={pushOpen} />
  {/if}
</div>

<style>
  /*
   * 1 つの画面の外枠。窓の高さいっぱいにし、ページそのものは巻かない (一覧は列の箱の中で巻く)。
   * 広い形は ヘッダー / 一覧の列 | 地図。スマホの形は地図を画面いっぱいにし、一覧はその上に重ねる面
   */
  .shell {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--so-bg);
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
  /*
   * ブラウザが音を止めている間の帯 (広い形はヘッダーのすぐ下、スマホの形は画面の上の端)。
   * 中身に重ねず押し下げるので、地図や一覧を隠さない。淡い面に注意の色のアイコンと見出しで、地は塗らない
   * (状態の赤で塗るのは、いま出ている緊急地震速報 (警報) の詳しい内容の箱と dock の 1 行だけ。design.md の 6.2)。右の「音を出す」は主のボタンと同じく操作の層に浮かせる。
   * 帯のどこを押しても鳴らせるようになる
   */
  .mute-band {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--so-space-3);
    width: auto;
    margin: 0 var(--so-space-3) var(--so-space-3);
    padding: var(--so-space-2) var(--so-space-2) var(--so-space-2)
      var(--so-space-4);
    border: 0;
    border-radius: var(--so-item-radius);
    background: var(--so-subtle);
    box-shadow: none;
    color: var(--so-fg);
    font-size: var(--so-text-base);
    font-weight: var(--so-weight);
    line-height: 1.4;
    text-align: start;
    /* 出るときに一度だけ、上から滑り込む (transform と opacity だけ) */
    animation: mute-enter var(--so-duration-enter) var(--so-ease-spring) both;
  }
  .mute-band > :global(svg) {
    flex-shrink: 0;
    color: var(--so-warn-text);
    /* 決めた回数だけ脈打って止まる (常時は回さない。動きを減らす設定では止まる) */
    --so-pulse-opacity: 0.55;
    --so-pulse-scale: 1.15;
    animation: var(--so-pulse);
  }
  .mute-text {
    display: flex;
    flex: 1 1 0%;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--so-space-2);
    min-width: 0;
  }
  .mute-head {
    color: var(--so-warn-text);
    font-weight: var(--so-weight-bold);
  }
  .mute-body {
    font-size: var(--so-text-sm);
  }
  .mute-action {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    min-height: var(--so-btn-h-sm);
    padding: 0 var(--so-space-4);
    border-radius: var(--so-radius-full);
    background: var(--so-btn-solid);
    box-shadow: var(--so-btn-lift);
    color: var(--so-btn-solid-text);
    font-size: var(--so-text-sm);
    font-weight: var(--so-weight-bold);
    white-space: nowrap;
    transition:
      background-color var(--so-duration) var(--so-ease),
      scale var(--so-duration-move) var(--so-ease-spring);
  }
  @media (hover: hover) {
    .mute-band:hover .mute-action {
      background: var(--so-btn-solid-hover);
    }
  }
  .mute-band:active .mute-action {
    scale: 0.97;
    transition: scale var(--so-duration) var(--so-ease);
  }
  @keyframes mute-enter {
    from {
      opacity: 0;
      transform: translateY(-0.5rem);
    }
  }
  /*
   * 読み上げ中断。動く中身 (地図・一覧) の上に重なるので、主のボタンと同じく操作の層に浮かせる。
   * 広い形は地図の左下 (右下はハザードマップの選択・現在地・出典)、スマホの形は dock のすぐ上の左。
   * 出るときは透明度と transform だけで少し下から出る
   */
  .speech-stop {
    position: fixed;
    left: calc(2 * var(--so-space-3));
    bottom: calc(2 * var(--so-space-3));
    z-index: var(--so-z-dock);
    gap: var(--so-space-2);
    margin: 0;
    white-space: nowrap;
    animation: speech-stop-enter var(--so-duration-enter) var(--so-ease-spring)
      both;
  }
  :global(:where(html[data-phone])) .speech-stop {
    left: var(--so-dock-inset);
    bottom: calc(
      var(--so-tabbar) + var(--so-dock-gap) + var(--dock-h) + var(--so-space-2)
    );
  }
  @keyframes speech-stop-enter {
    from {
      opacity: 0;
      transform: translateY(0.5rem);
    }
  }
  /* 受信に問題があるときだけの注意の印 (押すと情報源ごとの受信) */
  .trouble {
    gap: var(--so-space-1);
    color: var(--so-warn-text);
    white-space: nowrap;
  }
  :global(.menu.status-menu) {
    width: 22rem;
  }

  /*
   * ---- 本体 (広い形): 地図 | 一覧の列。列は右の 1 本だけにして、残りの幅を地図に回す ----
   * denpa の観る画面 (映像と右の列) と同じく、主の中身を左、添える列を右に置く。
   * DOM は一覧が先 (本文へ移動のリンクとキーボードの順) のまま、置く場所だけ入れ替える
   */
  .stage {
    display: grid;
    flex: 1 1 0%;
    grid-template-columns: minmax(0, 1fr) 22rem;
    min-height: 0;
  }
  .list-col {
    display: flex;
    grid-row: 1;
    grid-column: 2;
    flex-direction: column;
    min-height: 0;
  }
  /*
   * 列の上 (種類のチップと、カレンダーを開くボタン)。地のまま、巻かずに残す。
   * チップは列の幅に入りきらないぶんを次の行へ折り返す (横に流すと後ろの種類が隠れて見つけにくい)
   */
  .list-bar {
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: var(--so-space-1);
    padding: 0 var(--so-space-2) var(--so-space-2);
  }
  .list-bar .chips {
    flex: 1 1 0%;
    min-width: 0;
  }
  .list-bar .icon {
    flex-shrink: 0;
  }
  :global(.menu.cal-menu) {
    width: 18rem;
  }
  .list-pane {
    display: flex;
    flex: 1 1 0%;
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
  .notice-link {
    color: inherit;
    text-decoration: none;
  }
  .notice-link .small:last-child {
    white-space: pre-line;
  }
  .special-kinds {
    display: flex;
    flex-wrap: wrap;
    gap: var(--so-space-1);
    margin: var(--so-space-1) 0;
  }
  @media (hover: hover) {
    .notice-link:hover {
      background: var(--so-item-hover);
    }
  }
  .map-pane {
    --map-radius: var(--so-item-radius);
    grid-row: 1;
    grid-column: 1;
    isolation: isolate;
    min-height: 0;
    padding: 0 0 var(--so-space-3) var(--so-space-3);
  }
  .foot {
    margin-top: var(--so-space-4);
  }
  .foot p {
    margin: 0 0 var(--so-space-2);
    padding: 0 var(--so-space-3);
  }
  .phone-search,
  .dock,
  .tabbar {
    display: none;
  }
  @media (min-width: 1600px) {
    .stage {
      grid-template-columns: minmax(0, 1fr) 26rem;
    }
  }

  /* ---- スマホの形 (`<html data-phone>`) ---- */
  :global(:where(html[data-phone])) .shell {
    --so-tabbar: calc(4rem + 0.5rem + env(safe-area-inset-bottom));
    --dock-h: 2.75rem;
  }
  :global(:where(html[data-phone])) .navbar,
  :global(:where(html[data-phone])) .list-bar {
    display: none;
  }
  /* スマホの形の帯は画面の上の端いっぱい (ノッチの下から)。地図と一覧はその下から始まる */
  :global(:where(html[data-phone])) .mute-band {
    margin: 0;
    padding-top: calc(env(safe-area-inset-top) + var(--so-space-2));
    padding-inline: var(--so-space-3) var(--so-space-2);
    border-radius: 0;
  }
  /* 列の箱は作らず、一覧をこれまでどおり地図の上に重ねる */
  :global(:where(html[data-phone])) .list-col {
    display: contents;
  }
  :global(:where(html[data-phone])) .stage {
    position: relative;
    display: block;
  }
  :global(:where(html[data-phone])) .map-pane {
    --map-radius: 0;
    --map-top: env(safe-area-inset-top);
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

  /* dock (種類で絞るチップか選んでいるもの・案内の 1 行と、受信に問題があるときの注意の印)。下のタブから `--so-dock-gap` 上のカプセル */
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
  /* 選んでいるもの (地震でないもの) の 1 行。字だけのボタン (平ら) */
  .dock-selected {
    width: auto;
    min-height: calc(var(--dock-h) - 2 * var(--so-space-1));
    margin: 0;
    padding: 0 var(--so-space-3);
    border: 0;
    border-radius: var(--so-radius-full);
    background: transparent;
    box-shadow: none;
    font-weight: var(--so-weight);
    text-align: start;
  }
  /* いま出ている緊急地震速報 (警報) だけは状態の赤で塗る (docs/design.md の 6.2)。決めた回数だけ脈打って止まる */
  .dock-selected.eew-warning {
    background: var(--so-rec);
    color: #fff;
    font-weight: var(--so-weight-bold);
    --so-pulse-opacity: 0.7;
    --so-pulse-scale: 1.01;
    animation: var(--so-pulse);
  }
  .dock-selected.eew-forecast {
    color: var(--so-warn-text);
    font-weight: var(--so-weight-bold);
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
  .tabbar .tab {
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
    text-decoration: none;
    font-weight: var(--so-weight);
    line-height: 1.2;
    white-space: nowrap;
  }
  @media (hover: hover) {
    .tabbar .tab:hover,
    .tabbar .tab[aria-expanded="true"] {
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
    .tabbar .tab {
      font-size: var(--so-text-xs);
    }
  }
</style>
