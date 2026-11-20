<script lang="ts">
  import "maplibre-gl/dist/maplibre-gl.css";
  import type { LngLat, Map as MapLibreMap, Marker, Popup } from "maplibre-gl";
  // MapLibre の描き手の worker。既定では本体の隣の maplibre-gl-worker.mjs を探すが、束ねると
  // 見つからないので、Vite に別に束ねさせて URL を渡す
  import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
  import { untrack } from "svelte";
  import Locate from "~icons/lucide/locate";
  import LocateFixed from "~icons/lucide/locate-fixed";
  import TriangleAlert from "~icons/lucide/triangle-alert";

  import { alerter } from "#lib/alerter.svelte.ts";
  import Icon from "#lib/components/Icon.svelte";
  import Menu from "#lib/components/Menu.svelte";
  import { failureText } from "#lib/failure.ts";
  import {
    INTENSITY_COLORS,
    jst,
    jstFull,
    kindText,
    VOLCANO_COLORS,
    volcanoKindText,
    WARNING_COLORS,
  } from "#lib/format.ts";
  import { type Box, edgePadding } from "#lib/map/edges.ts";
  import {
    type EpicenterHit,
    epicenterReach,
    FOREIGN_RADIUS,
    HYPO_RADIUS,
    nearestEpicenter,
    radiusAt,
  } from "#lib/map/epicenters.ts";
  import {
    autoLocate,
    type GeoPermission,
    LOCATE_PREF,
    readLocate,
  } from "#lib/map/locate.ts";
  import {
    MARINE_URL,
    marineIcons,
    type MarinePoint,
    marinePopup,
    type MarineResponse,
    nearestMarine,
  } from "#lib/map/marine.ts";
  import {
    forecastFrames,
    hoursAhead,
    latestAnalysis,
    N3_STALE_MS,
    N3_TILE_ZOOMS,
    N3_TIMES_URL,
    nextN3Poll,
    NOWC_KINDS,
    NOWC_PAGE,
    NOWC_RETRY_MS,
    type NowcFrame,
    type NowcKind,
    nowcOf,
    nowcStale,
    nowcTiles,
    RASRF_LEGEND,
    RASRF_PAGE,
    RASRF_POLL_MS,
    RASRF_TILE_ZOOMS,
    RASRF_TIMES_URL,
    rasrfStale,
    rasrfTiles,
    slmcsFeatures,
    slmcsUrl,
    stampIso,
  } from "#lib/map/nowc.ts";
  import { coordLabel, coordText, longPressOk } from "#lib/map/press.ts";
  import {
    latestRain,
    nextRainPoll,
    RAIN_CREDIT,
    RAIN_LEGEND,
    RAIN_PAGE,
    RAIN_RETRY_MS,
    RAIN_TILE_ZOOMS,
    RAIN_TIMES_URL,
    type RainFrame,
    rainIso,
    rainStale,
    rainTiles,
  } from "#lib/map/rain.ts";
  import { type MapView, ViewKeeper } from "#lib/map/restore.ts";
  import {
    latestRisk,
    nextRiskPoll,
    RISK_CREDIT,
    RISK_LEGEND,
    RISK_PAGE,
    RISK_RETRY_MS,
    RISK_TILE_ZOOMS,
    RISK_TIMES_URL,
    type RiskFrame,
    riskIso,
    type RiskKind,
    riskOf,
    RISKS,
    riskStale,
    riskTiles,
  } from "#lib/map/risk.ts";
  import {
    type RoadLine,
    roadPopup,
    type RoadResponse,
    ROADS_REFRESH_MS,
    ROADS_URL,
  } from "#lib/map/roads.ts";
  import {
    nearestStation,
    stationFeatures,
    type StationIndex,
    stationIndex,
    STATIONS_URL,
    type StationTable,
  } from "#lib/map/stations.ts";
  import {
    baseStyle,
    eewFill,
    foreignFeatures,
    HAZARD_CHOICES,
    HAZARD_GROUPS,
    hazardChoice,
    hazardCovers,
    hazardFamily,
    type HazardId,
    HAZARDS,
    hazardVisibility,
    homeFilter,
    hypocenterFeatures,
    intensityFill,
    intensityLabels,
    JAPAN_BOUNDS,
    longPeriodLine,
    meFeatures,
    mergeShelters,
    nowcShown,
    nowcVisibility,
    officeBounds,
    officeFilter,
    type OfficeTable,
    overlayVisibility,
    quakeFillOpacity,
    rainShown,
    rainVisibility,
    rasrfVisibility,
    readHazard,
    riskShown,
    riskVisibility,
    SHELTER_DISASTERS,
    SHELTER_LAYERS,
    SHELTER_MIN_ZOOM,
    SHELTER_TILE_ZOOM,
    specialWarningFilter,
    TEXT_FONT_CSS,
    tilesIn,
    tsunamiPaint,
    volcanoMarks,
    warningFill,
  } from "#lib/map/style.ts";
  import {
    nearestTyphoonPoint,
    typhoonBounds,
    typhoonFeatures,
    type TyphoonPoint,
    typhoonPopup,
  } from "#lib/map/typhoon.ts";
  import {
    cityLevels,
    cityWarnings,
    type Eew,
    type ForeignQuake,
    intensityLabel,
    type LongPeriod,
    type Quake,
    type Tsunami,
    type Volcano,
    type WeatherInfo,
    type WeatherWarning,
  } from "#lib/model.ts";
  import { mapCredit, showsGrus } from "#lib/notice.ts";
  import type { Place } from "#lib/places.ts";
  import { readPref, writePref } from "#lib/prefs.ts";
  import { homeAt, saveHome, trackHere } from "#lib/push-client.ts";
  import { rtsFeatures, type RtsFrame, type RtsStation } from "#lib/rts.ts";

  /**
   * 地図 (docs/map.md)。下地は国土地理院のシームレス空中写真。その上に層をいつも全部重ねる (オン・オフは無い)。
   * カメラは飛ばさない (jumpTo)。MapLibre は止まっている間は描かないので、開いているだけで CPU は使わない。
   */
  let {
    quake,
    longPeriod,
    quakes,
    tsunamis,
    eews,
    volcanoes = [],
    volcano = null,
    foreign = [],
    foreignQuake = null,
    rtsStations = [],
    rts = null,
    seisStations = [],
    seis = null,
    warnings = [],
    typhoons = [],
    typhoon = null,
    office = null,
    officeHref,
    onoffice,
    aboutHref = "/?about=1",
    found = null,
    selected = false,
    onstations,
    onpick,
  }: {
    /**
     * 震源の丸を押したとき (一覧でその地震を選んだのと同じにする)。`kind` は国内の地震 (`quake`) か海外の地震
     * (`foreign`)。docs/map.md の「震源の丸を押したとき」
     */
    onpick?: (kind: "quake" | "foreign", id: string) => void;
    /**
     * 選んだ地震の観測点を地図に置いたとき、位置の引けなかった観測点の名前を渡す (詳しい内容に数を出す)。
     * 置いていないとき (地震を選んでいない・位置の表をまだ読んでいない) は null
     */
    onstations?: (r: { id: string; missing: string[] } | null) => void;
    /** いまの気象警報・注意報 (市町村等を段の色で塗る。押すと吹き出し) */
    warnings?: WeatherWarning[];
    /** 地図に描く台風 (台風ごとにいちばん新しい報。`#lib/map/typhoon.ts` の `typhoonsOnMap`) */
    typhoons?: WeatherInfo[];
    /** 一覧で選んだ台風の報 (線を太くし、予報円が収まるよう寄せる) */
    typhoon?: WeatherInfo | null;
    /** 一覧で選んだ府県予報区のコード (その市町村等を縁取り、寄せる) */
    office?: string | null;
    /** 府県予報区の警報・注意報の詳しい内容のリンク (一覧の行と同じ `?w=office-<コード>`) */
    officeHref?: (code: string) => string;
    /** 吹き出しから詳しい内容を開いたとき (スマホの形で一覧のタブへ移る) */
    onoffice?: () => void;
    quake: Quake | undefined;
    /** 地図に出している地震の長周期地震動 (無ければ枠を描かない) */
    longPeriod?: LongPeriod | null;
    quakes: Quake[];
    tsunamis: Tsunami[];
    eews: Eew[];
    /** 火山ごとのいまの噴火警報・予報 */
    volcanoes?: Volcano[];
    /** 選んだ火山の報 (寄せる) */
    volcano?: Volcano | null;
    /** 海外の地震 (点) と、選んだ海外の地震 (震央の × と寄せ先) */
    foreign?: ForeignQuake[];
    foreignQuake?: ForeignQuake | null;
    /** 台湾の観測点 (TREM-RTS) の位置と、いまの揺れ (点の色だけ。docs/design.md の 2.9) */
    rtsStations?: RtsStation[];
    rts?: RtsFrame | null;
    /** Wolfx SeisJS の観測点の位置と、いまの揺れ (台湾の観測点と同じ扱い。docs/design.md の 2.10) */
    seisStations?: RtsStation[];
    seis?: RtsFrame | null;
    /** 検索の欄で選んだ場所 (寄せて印を置く。`n` が替わるたびに寄せる) */
    found?: { place: Place; n: number } | null;
    /** 隅の出典を押したときに開く「出典と注意」の窓のリンク */
    aboutHref?: string;
    /** 詳しい内容を開いているか (閉じたら、開く前の地図の位置へ戻す。`#lib/map/restore.ts`) */
    selected?: boolean;
  } = $props();

  /** 見ている範囲が GRUS 画像の範囲 (沖ノ鳥島のあたり) にかかるか (隅の出典に足す) */
  let grus = $state(false);

  /** pmtiles の読み方は MapLibre に 1 度だけ足す (地図を作り直しても足し直さない) */
  let pmtilesAdded = false;
  let PopupClass: typeof Popup | undefined;
  let container = $state<HTMLDivElement>();
  let map = $state<MapLibreMap | undefined>();
  /** 地図を出せない理由 (出せるときは空) */
  let failed = $state("");
  let MarkerClass: typeof Marker | undefined;
  let points: Record<string, [number, number]> = {};
  /** 名前 → 細分区域のコード (P2P は名前だけで来る) */
  const codeByName = new Map<string, string>();
  let markers: Marker[] = [];
  /** 火山の印 (震度のラベルとは別に出し入れする) と、活火山の位置の表 */
  let volcanoMarkers: Marker[] = [];
  let volcanoPoints = $state<Record<string, [number, number, string?]>>({});

  $effect(() => {
    // WebGL が無い端末では地図を出さない (一覧で見てもらう)
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) {
      failed = "WebGL が使えないため、地図を出せません。一覧から見てください。";
      return;
    }
    let disposed = false;
    let created: MapLibreMap | undefined;
    void (async () => {
      const [
        { Map: MapClass, Marker: M, Popup: P, setWorkerUrl, addProtocol },
        { Protocol },
        pts,
        areas,
        vpts,
        anno,
      ] = await Promise.all([
        import("maplibre-gl"),
        import("pmtiles"),
        fetch("/areas/quake-points.json").then((r) => r.json()),
        fetch("/areas/quake-areas.geojson").then((r) => r.json()),
        // 火山の位置の表は無くても地図は出す (印は電文の位置だけで置く)
        fetch("/areas/volcano-points.json")
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
        // 地理院の注記 (地名・施設の記号) の層。無くても地図は出す
        fetch("/map/gsi/anno.json")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ]);
      if (disposed || !container) return;
      setWorkerUrl(workerUrl);
      // 地理院地図Vector は PMTiles の 1 ファイル。範囲を指定して要るタイルだけを読む
      if (!pmtilesAdded) {
        pmtilesAdded = true;
        addProtocol("pmtiles", new Protocol().tile);
      }
      MarkerClass = M;
      PopupClass = P;
      volcanoPoints = vpts as Record<string, [number, number, string?]>;
      points = pts as Record<string, [number, number]>;
      for (const f of (
        areas as { features: { properties: { code: string; name: string } }[] }
      ).features)
        codeByName.set(f.properties.name, f.properties.code);
      created = new MapClass({
        container,
        style: baseStyle(
          location.origin,
          untrack(() => hazard),
        ) as never,
        bounds: JAPAN_BOUNDS,
        // MapLibre の (i) は押すまで出典が見えないので出さず、隅の短い出典をいつも出す (docs/map.md)
        attributionControl: false,
        // 回すと読みにくいだけなので、北を上に固定する
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
      created.touchZoomRotate.disableRotation();
      created.on("load", () => {
        if (disposed || !created) return;
        created.addImage("shelter", shelterIcon(false), { pixelRatio: 2 });
        created.addImage("shelter-welfare", shelterIcon(true), {
          pixelRatio: 2,
        });
        for (const [id, img] of Object.entries(marineIcons()))
          created.addImage(id, img, { pixelRatio: 2 });
        void loadMarine(created);
        void loadRoads(created);
        for (const l of anno as { id: string }[])
          if (!created.getLayer(l.id)) created.addLayer(l as never, "shelters");
        created.on("moveend", () => {
          void loadShelters();
          // GRUS 画像の範囲を映しているときは、隅の出典に足す
          if (created) {
            grus = showsGrus(
              created.getBounds().toArray().flat() as never,
              created.getZoom(),
            );
            zoom = created.getZoom();
          }
        });
        // 地図のメニューを開いている間 (長押しの指を離したときの click も) は吹き出しを出さない
        created.on("click", "shelters", (e) => {
          if (placeMenu) return;
          const f = e.features?.[0];
          if (f) openShelter(f.properties as Record<string, unknown>, e.lngLat);
        });
        // 観測点の丸を押すと、観測点の名前・震度・場所・設置者の吹き出し。押せる範囲は丸より広い (`stationHit`)。
        // 上の層 (避難場所の印) を押したときはそちらだけ。震央の × と震度のラベルは吹き出しを持たないので、
        // その下の丸を選ぶ。どれでもなければ海しるの点・線・震源の丸の順 (docs/map.md の「押せる所が重なったとき」)
        created.on("click", (e) => {
          if (
            !created ||
            placeMenu ||
            created.queryRenderedFeatures(e.point, { layers: ["shelters"] })
              .length > 0
          )
            return;
          const s = stationHit(e.point, e.originalEvent);
          if (s) return openStation(s.properties, s.at);
          // 海しるの点 (観測点の丸の下に描いている)
          const mk = marineHit(e.point, e.originalEvent);
          if (mk) return openMarine(mk.properties, mk.at);
          // 台風の実況の中心と予報円の中心 (海しるの点の下、通行止めの線の上に描いている)
          const ty = typhoonHit(e.point, e.originalEvent);
          if (ty) return openTyphoon(ty.properties, ty.at);
          // 災害時の通行止めと通れた道 (目安) の線 (点の下に描いている)
          const rd = roadHit(e.point, e.originalEvent);
          if (rd) return openRoad(rd, e.lngLat);
          // 震源の丸 (線と点の下に描いている)。押すと一覧でその地震を選んだのと同じにする
          const ep = epicenterHit(e.point, e.originalEvent);
          if (ep) {
            closePopups();
            onpick?.(ep.kind, ep.id);
          }
        });
        // マウスでは押せるものの上でだけ指の形にする
        for (const id of POINTER_LAYERS) {
          created.on("mouseenter", id, () => {
            if (created) created.getCanvas().style.cursor = "pointer";
          });
          created.on("mouseleave", id, () => {
            if (created) created.getCanvas().style.cursor = "";
          });
        }
        // 塗った市町村等を押すと、出ている警報・注意報の吹き出し。上の層 (避難場所の印・観測点の丸・海しるの点・
        // 通行止めと通れた道の線・震源の丸) を押したときはそちらだけ
        created.on("click", "warning-fill", (e) => {
          if (
            !created ||
            placeMenu ||
            created.queryRenderedFeatures(e.point, { layers: ["shelters"] })
              .length > 0 ||
            stationHit(e.point, e.originalEvent) ||
            marineHit(e.point, e.originalEvent) ||
            typhoonHit(e.point, e.originalEvent) ||
            roadHit(e.point, e.originalEvent) ||
            epicenterHit(e.point, e.originalEvent)
          )
            return;
          const code = e.features?.[0]?.properties?.code;
          if (typeof code === "string") openWarning(code, e.lngLat);
        });
        // 面は塗っていない所にもあるので、塗った所の上でだけ指の形にする。上の押せるもの (震源の丸など) の上でも指の形
        created.on("mousemove", "warning-fill", (e) => {
          if (!created) return;
          const code = e.features?.[0]?.properties?.code;
          const over =
            created.queryRenderedFeatures(e.point, {
              layers: POINTER_LAYERS.filter((id) => created?.getLayer(id)),
            }).length > 0;
          created.getCanvas().style.cursor =
            over || (typeof code === "string" && paintedCities.has(code))
              ? "pointer"
              : "";
        });
        created.on("mouseleave", "warning-fill", () => {
          if (created) created.getCanvas().style.cursor = "";
        });
        // 指の長押しで、その場所のメニュー。長押しは MapLibre が数え (指 1 本で、クリックの許す幅より動かず
        // 500 ミリ秒。2 本指や動かしたら取りやめ。iPhone の Safari のように contextmenu を出さない端末でも)、
        // 作った contextmenu を送ってくる (isTrusted でない)。マウスの右クリックは下の DOM の contextmenu で受ける
        created.on("contextmenu", (e) => {
          if (e.originalEvent.isTrusted) return;
          if (!pressStill(e.point.x, e.point.y)) return;
          openPlace(e.point.x, e.point.y, e.lngLat.lat, e.lngLat.lng);
        });
        // 地図が動いたらメニューを閉じる (押した所から離れるため)
        created.on("movestart", (e) => {
          pressMoved = true;
          placeMenu = false;
          // 人が動かした (引く・つまむ・ホイール・ダブルクリック・キー) ときだけ `originalEvent` が付く。jumpTo と大きさの
          // 測り直しには付かない。詳しい内容を開いている間に人が動かしたら、閉じても元の位置へ戻さない
          if ((e as { originalEvent?: unknown }).originalEvent) keeper.moved();
        });
        map = created;
        // 手元 (vite dev) で画面を撮るときに、地図を動かせるようにする (本番の束には入らない)
        if (import.meta.env.DEV)
          (window as unknown as { sonaeMap?: MapLibreMap }).sonaeMap = created;
        grus = showsGrus(
          created.getBounds().toArray().flat() as never,
          created.getZoom(),
        );
        zoom = created.getZoom();
      });
    })().catch((err: unknown) => {
      console.warn(`地図を開けませんでした: ${err}`);
      failed =
        "地図を読み込めませんでした。つながりを確かめて、読み込み直してください。";
    });
    return () => {
      disposed = true;
      paintedSig = "";
      stationSig = "";
      warningSig = "";
      markedSig = "";
      volcanoSig = "";
      foundMarker?.remove();
      foundMarker = undefined;
      foundN = 0;
      for (const m of [...markers, ...volcanoMarkers]) m.remove();
      markers = [];
      volcanoMarkers = [];
      created?.remove();
      map = undefined;
    };
  });

  /**
   * 中身が変わったときだけ描き直す。画面は 10 秒ごとに時刻を進めて並びを作り直すので、
   * 並びが替わっただけで描き直すと、印の脈打ちが繰り返し始まり、要らない描き直しも増える
   */
  const sig = (...parts: unknown[]) => JSON.stringify(parts);
  /** GeoJSON の source の中身を差し替える */
  function setData(m: MapLibreMap, id: string, data: unknown): void {
    const src = m.getSource(id);
    if (src && "setData" in src)
      (src as { setData(d: unknown): void }).setData(data);
  }
  const eewSig = (es: Eew[]) =>
    es.map((e) => [e.eventId, e.serial, e.cancelled, e.warnAreas.length]);
  let paintedSig = "";
  let markedSig = "";

  // 気象警報・注意報の色 (報が替わったときだけ塗り直す)
  let warningSig = "";
  /** 塗っている市町村等 (指の形にするか決める) */
  let paintedCities: ReadonlyMap<string, unknown> = new Map();
  /** 塗っている市町村等があるか・特別警報の市町村等があるか (地震を選んでいる間に、隠していることを書くか決める) */
  let warningsPainted = $state(false);
  let specialPainted = $state(false);
  $effect(() => {
    if (!map) return;
    const next = sig(warnings.map((w) => [w.id, w.reportedAt]));
    if (next === warningSig) return;
    warningSig = next;
    const levels = cityLevels(warnings);
    paintedCities = levels;
    const ls = [...levels.values()];
    warningsPainted = ls.some((l) => l > 0);
    specialPainted = ls.includes(5);
    map.setPaintProperty(
      "warning-fill",
      "fill-color",
      warningFill(levels) as never,
    );
    // ハザードマップを重ねている間に出す、特別警報の市町村等の縁取り
    const special = specialWarningFilter(levels) as never;
    map.setFilter("warning-special-casing", special);
    map.setFilter("warning-special", special);
    // 開いている吹き出しは前の報の中身なので閉じる
    warningPopup?.remove();
  });

  // ---- 府県予報区の縁取り (一覧で選んだとき。表は選んだときに初めて読む) ----
  let offices = $state<OfficeTable | null>(null);
  let officesLoading = false;
  $effect(() => {
    if (!office || offices || officesLoading) return;
    officesLoading = true;
    fetch("/areas/offices.json")
      .then((r) => {
        // 読めなかったときは空の表を持たず、次に選んだときに読み直す
        if (!r.ok) throw new Error(`offices.json: ${r.status}`);
        return r.json() as Promise<OfficeTable>;
      })
      .then((t) => (offices = t))
      .catch(() => (officesLoading = false));
  });
  $effect(() => {
    if (!map) return;
    const f = officeFilter(offices ?? {}, office) as never;
    map.setFilter("warning-focus-casing", f);
    map.setFilter("warning-focus", f);
  });

  // 震度の色・津波の線・緊急地震速報の地域・震源の点
  $effect(() => {
    if (!map) return;
    const next = sig(
      quake?.id,
      quake?.updatedAt,
      longPeriod?.updatedAt,
      eewSig(eews),
      tsunamis.map((t) => [t.id, t.updatedAt]),
      quakes.slice(0, 50).map((q) => [q.id, q.updatedAt]),
      foreign.slice(0, 50).map((q) => [q.id, q.updatedAt]),
    );
    if (next === paintedSig) return;
    paintedSig = next;
    map.setPaintProperty(
      "quake-fill",
      "fill-color",
      intensityFill(quake?.areas ?? []) as never,
    );
    map.setPaintProperty(
      "longperiod-line",
      "line-color",
      longPeriodLine(
        longPeriod && !longPeriod.cancelled ? longPeriod.areas : [],
      ) as never,
    );
    const warn = eewFill(eews, "#d93526");
    map.setPaintProperty("eew-fill", "fill-color", warn as never);
    map.setPaintProperty("eew-line", "line-color", warn as never);
    const t = tsunamiPaint(tsunamis);
    map.setPaintProperty("tsunami", "line-color", t.color as never);
    map.setPaintProperty("tsunami", "line-width", t.width as never);
    setData(map, "hypocenters", hypocenterFeatures(quakes));
    setData(map, "foreign", foreignFeatures(foreign));
  });

  // ---- 観測点ごとの震度 (位置の表は、観測点の並ぶ地震を初めて出すときに読む。docs/map.md) ----
  let stationIdx = $state<StationIndex | null>(null);
  let stationsLoading = false;
  $effect(() => {
    if (!quake?.stations.length || stationIdx || stationsLoading) return;
    stationsLoading = true;
    fetch(STATIONS_URL)
      .then((r) => {
        // 読めなかったときは表を持たず、次に地震を選んだときに読み直す
        if (!r.ok) throw new Error(`intensity-stations-v2.json: ${r.status}`);
        return r.json() as Promise<StationTable>;
      })
      .then((t) => (stationIdx = stationIndex(t)))
      .catch((err: unknown) => {
        console.warn(`震度観測点の位置の表を読めませんでした: ${err}`);
        stationsLoading = false;
      });
  });
  let stationSig = "";
  $effect(() => {
    if (!map) return;
    const next = sig(quake?.id, quake?.updatedAt, stationIdx !== null);
    if (next === stationSig) return;
    stationSig = next;
    const r =
      quake && stationIdx ? stationFeatures(quake.stations, stationIdx) : null;
    setData(
      map,
      "stations",
      r?.data ?? { type: "FeatureCollection", features: [] },
    );
    map.setPaintProperty(
      "quake-fill",
      "fill-opacity",
      quakeFillOpacity((r?.data.features.length ?? 0) > 0) as never,
    );
    onstations?.(quake && r ? { id: quake.id, missing: r.missing } : null);
    // 開いている吹き出しは前の地震 (前の報) の中身なので閉じる
    stationPopup?.remove();
  });

  // 台風の予報円・暴風警戒域・暴風域・強風域と中心 (docs/map.md の「台風」)。中身が変わったときだけ差し替える
  let typhoonSig = "";
  const typhoonById = new Map<string, WeatherInfo>();
  $effect(() => {
    if (!map) return;
    const next = sig(
      typhoons.map((w) => [w.id, w.updatedAt]),
      typhoon?.series ?? null,
    );
    if (next === typhoonSig) return;
    typhoonSig = next;
    typhoonById.clear();
    for (const w of typhoons) typhoonById.set(w.id, w);
    const f = typhoonFeatures(typhoons, typhoon?.series ?? null);
    setData(map, "typhoon", f.lines);
    setData(map, "typhoon-points", f.points);
    // 前の中身の吹き出しは閉じる
    untrack(() => typhoonPopupEl?.remove());
  });

  // 台湾の観測点 (TREM-RTS)。地震の間は 0.5 秒ごとに替わるので、この点だけを差し替える
  $effect(() => {
    if (map) setData(map, "rts", rtsFeatures(rtsStations, rts));
  });

  // 有志の観測点 (Wolfx SeisJS)。見た目が変わったときと 5 秒ごとに届く
  $effect(() => {
    if (map) setData(map, "seis", rtsFeatures(seisStations, seis));
  });

  // 震度のラベル・震央の印 (字を描くのに地図用の字体を落とさないよう、DOM の印で置く)
  $effect(() => {
    if (!map || !MarkerClass) return;
    const next = sig(
      quake?.id,
      quake?.updatedAt,
      eewSig(eews),
      foreignQuake?.id,
    );
    if (next === markedSig) return;
    markedSig = next;
    for (const m of markers) m.remove();
    markers = [];
    if (quake) {
      for (const l of intensityLabels(quake.areas, points, codeByName)) {
        const el = document.createElement("span");
        const c = INTENSITY_COLORS[l.int];
        el.className = "int-label";
        el.textContent = intensityLabel(l.int);
        el.title = `${l.name} 震度${intensityLabel(l.int)}`;
        if (c) {
          el.style.background = c.bg;
          el.style.color = c.fg;
        }
        markers.push(
          new MarkerClass({ element: el }).setLngLat(l.at).addTo(map),
        );
      }
    }
    if (
      quake?.hypocenter?.lat !== undefined &&
      quake.hypocenter.lon !== undefined
    ) {
      const el = epicenter(`震央 ${quake.hypocenter.name}`, false);
      markers.push(
        new MarkerClass({ element: el })
          .setLngLat([quake.hypocenter.lon, quake.hypocenter.lat])
          .addTo(map),
      );
    }
    if (foreignQuake) {
      const el = epicenter(`震央 ${foreignQuake.place}`, false);
      markers.push(
        new MarkerClass({ element: el })
          .setLngLat([foreignQuake.lon, foreignQuake.lat])
          .addTo(map),
      );
    }
    for (const e of eews) {
      if (
        e.cancelled ||
        e.hypocenter?.lat === undefined ||
        e.hypocenter.lon === undefined
      )
        continue;
      const el = epicenter(
        `緊急地震速報の震央 ${e.hypocenter.name}${e.assumed ? " (仮定震源)" : ""}`,
        true,
      );
      markers.push(
        new MarkerClass({ element: el })
          .setLngLat([e.hypocenter.lon, e.hypocenter.lat])
          .addTo(map),
      );
    }
  });

  // 火山の印 (三角と警戒の段の数字)。色は気象庁の配色の指針の噴火警報・予報の色
  let volcanoSig = "";
  $effect(() => {
    if (!map || !MarkerClass) return;
    const marks = volcanoMarks(volcanoes, volcano, volcanoPoints);
    const next = sig(marks);
    if (next === volcanoSig) return;
    volcanoSig = next;
    for (const m of volcanoMarkers) m.remove();
    volcanoMarkers = [];
    for (const v of marks) {
      const outer = document.createElement("div");
      const el = document.createElement("span");
      const c = v.level ? VOLCANO_COLORS[v.level] : undefined;
      el.className = v.selected ? "volcano-mark selected" : "volcano-mark";
      el.textContent = v.level ? String(v.level) : "";
      if (c) {
        el.style.setProperty("--volcano-bg", c.bg);
        el.style.color = c.fg;
      }
      outer.className = "volcano-wrap";
      outer.title = `${v.name} ${volcanoKindText(v.kind)}`;
      outer.append(el);
      // 段が分からない火山は三角に数字が無いので、横に種類を字で出す (色だけに頼らない)
      if (v.label) {
        const cap = document.createElement("span");
        cap.className = "volcano-caption";
        cap.textContent = v.label;
        const lc = v.labelLevel ? VOLCANO_COLORS[v.labelLevel] : undefined;
        if (lc) {
          cap.style.background = lc.bg;
          cap.style.color = lc.fg;
        }
        outer.append(cap);
      }
      volcanoMarkers.push(
        new MarkerClass({ element: outer, anchor: "bottom" })
          .setLngLat(v.at)
          .addTo(map),
      );
    }
  });

  // ---- 現在地 (オンの間だけ watchPosition で追う。既定はオン。位置は端末の中で描き、入る市町村等を開いているときの
  // 通知の「住んでいる地域と現在地」に使うだけで、サーバーには送らない) ----
  // 選んだオン・オフは端末に覚え、開いたときは `#lib/map/locate.ts` の決まりで自動で始める
  type Locating = "off" | "waiting" | "on";
  let locating = $state<Locating>("off");
  /** オンを覚えているか。許可を待っていて追っていない間も true (ボタンはオンの見た目で、押すと始める) */
  let remembered = $state(false);
  /** オンを覚えているのに、まだ追っていない (開いたときに許可が無かった) */
  const paused = $derived(remembered && locating === "off");
  /** 位置を取れないわけ (無ければ空)。操作の 1 行の上に積んで出す */
  let locateNote = $state("");
  let me = $state<{ lon: number; lat: number; accuracy: number }>();
  let watchId: number | undefined;
  /** 今回始めてから、もう寄せたか (寄せるのは押して始めたときの最初の 1 回だけ。自動で始めたときは寄せない) */
  let panned = false;

  function stopLocating(): void {
    if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    watchId = undefined;
    locating = "off";
    me = undefined;
  }

  /** 人が選んだ (か、許可が拒まれた) オン・オフを覚える。既定はオンなので、オフも覚える */
  function rememberLocate(on: boolean): void {
    remembered = on;
    writePref(LOCATE_PREF, on ? "on" : "off");
  }

  /** 追い始める。`pan` は押して始めたとき (最初に取れた所へ寄せる) */
  function startLocating(pan: boolean): void {
    if (!("geolocation" in navigator)) {
      // 開いたときに自動で始めようとしたときは、何も言わずにオフにする (押したときだけ言う)
      if (pan) locateNote = "このブラウザは位置を取れません";
      rememberLocate(false);
      return;
    }
    locating = "waiting";
    panned = !pan;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        locating = "on";
        me = {
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy,
        };
      },
      (err) => {
        // 許可されなかったときは追うのをやめ、オフを覚える (聞き直さない)。一時的に取れないだけなら追い続ける
        if (err.code === err.PERMISSION_DENIED) {
          stopLocating();
          rememberLocate(false);
          locateNote =
            "位置の利用が許可されていません。ブラウザのサイトの設定で許可すると使えます";
        } else if (locating === "waiting") {
          locateNote =
            "位置を取れませんでした。しばらくすると、取れたら出します";
        }
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000 },
    );
  }

  function toggleLocate(): void {
    locateNote = "";
    if (locating !== "off") {
      stopLocating();
      rememberLocate(false);
      return;
    }
    // 覚えたオンで待っているときに押しても、ここで始める (許可の窓は押したこの操作の中で出る)
    rememberLocate(true);
    startLocating(true);
  }

  // 開いたとき: オフを選んでいなければ (既定はオン)、位置の許可がもうあれば自動で始める。まだ選んでいない
  // 端末は許可を聞く (断られたらオフを覚える)。人がオンにした端末で許可が消えていたら、押すのを待つ。
  // 許可が変わったら (サイトの設定で変えたとき) 合わせる。拒まれたらオフを覚える (聞き直さない)
  $effect(() => {
    const choice = readLocate(readPref(LOCATE_PREF));
    remembered = choice !== "off";
    let status: PermissionStatus | undefined;
    let gone = false;
    const apply = (p: GeoPermission) => {
      // 覚えた選択は、許可が変わったときにも読み直す (押して選び直していることがある)
      const next = autoLocate(readLocate(readPref(LOCATE_PREF)), p);
      if ((next === "start" || next === "ask") && locating === "off")
        startLocating(false);
      else if (next === "forget") {
        stopLocating();
        rememberLocate(false);
      }
    };
    void (async () => {
      let p: GeoPermission = "unknown";
      try {
        status = await navigator.permissions.query({ name: "geolocation" });
        p = status.state;
      } catch {
        // query が無い・geolocation を聞けないブラウザは unknown のまま (autoLocate が決める。まだ選んでいなければ聞く)
      }
      if (gone) return;
      apply(p);
      if (status) {
        const s = status;
        s.onchange = () => apply(s.state);
      }
    })();
    return () => {
      gone = true;
      if (status) status.onchange = null;
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    };
  });

  // 現在地が入る市町村等を、開いているときの通知の範囲に使う (端末の中だけ。緯度・経度は送らない)。
  // 前の市町村等の中にいる間は面を引き直さない (`trackHere`)
  $effect(() => {
    void trackHere(me ? { lat: me.lat, lon: me.lon } : undefined);
  });
  // 地図が外れたら (位置も追わなくなる) 現在地の市町村等を空にする
  $effect(() => () => void trackHere(undefined));

  // 現在地を描き、押して始めたときは最初に取れたときだけそこへ寄せる
  $effect(() => {
    if (!map) return;
    setData(
      map,
      "me",
      me
        ? meFeatures(me.lon, me.lat, me.accuracy)
        : { type: "FeatureCollection", features: [] },
    );
    if (me && !panned) {
      panned = true;
      locateNote = "";
      // 人が現在地のボタンを押して寄せた所なので、詳しい内容を閉じても元の位置へ戻さない
      untrack(() => keeper.moved());
      map.jumpTo({
        center: [me.lon, me.lat],
        zoom: Math.max(map.getZoom(), 13),
      });
    }
  });

  // ---- 重ねる図 (なし・雨雲・キキクル・ハザードマップ・地震の備えの図から 1 つ。色がぶつかるので重ねない。端末に覚える) ----
  // 選んでいる間は、面で塗る警報・注意報や震度の色を隠す (`overlayVisibility`。特別警報は縁取りで残す)
  let hazard = $state<HazardId>("none");
  let hazardMenu = $state(false);
  $effect.pre(() => {
    hazard = readHazard(readPref("map.hazard"));
  });
  const chosenHazard = $derived(HAZARDS.find((h) => h.id === hazard));
  /** 凡例の上で切り替えられる図 (洪水の 3 つ。無ければ空) */
  const family = $derived(hazardFamily(hazard));
  /** いまのズーム (動き終わったときに写す)。活断層はズーム 11 からしかタイルが無い */
  let zoom = $state(0);
  /** 選んだハザードマップが、いまのズームで地図に重なっているか */
  const covered = $derived(hazardCovers(hazard, zoom));
  /** 地図の隅にいつも出す短い出典 (映している層に合わせる) */
  const creditText = $derived(
    mapCredit({ hazard: covered ? (chosenHazard?.credit ?? "") : "", grus }),
  );
  /**
   * 選択肢をどう開いたか。マウスを乗せて開いた ("hover") ときは、外れたら少し待って閉じ、フォーカスは動かさない
   * (乗せただけで、打っている欄からフォーカスを取らない)。押して・キーで開いたときは今までどおり
   */
  let hazardBy = $state<"" | "hover" | "press">("");
  let hazardTimer: ReturnType<typeof setTimeout> | undefined;
  /** 外れてから閉じるまで (ミリ秒)。選択肢へ指を動かす間に閉じないように */
  const HAZARD_CLOSE_MS = 300;
  const canHover = () =>
    typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
  function hazardEnter(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || !canHover() || !map) return;
    clearTimeout(hazardTimer);
    if (hazardMenu) return;
    hazardBy = "hover";
    hazardMenu = true;
  }
  function hazardLeave(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || hazardBy !== "hover") return;
    clearTimeout(hazardTimer);
    hazardTimer = setTimeout(() => {
      if (hazardBy === "hover") hazardMenu = false;
    }, HAZARD_CLOSE_MS);
  }
  /** 乗せて開いている間に押したら、閉じずに開いたままにする (外れても閉じない) */
  function hazardClick(event: MouseEvent): void {
    clearTimeout(hazardTimer);
    // マウスで押したときだけ (Enter・スペースの click は detail が 0。キーボードでは今までどおり開け閉めする)
    if (hazardBy === "hover" && hazardMenu && event.detail > 0) {
      // popovertarget の開け閉めを止める (押したら閉じてしまうため)
      event.preventDefault();
      hazardBy = "press";
      return;
    }
    hazardBy = "press";
  }
  $effect(() => () => clearTimeout(hazardTimer));

  function pickHazard(id: HazardId): void {
    hazard = id;
    hazardMenu = false;
    writePref("map.hazard", id);
  }
  /**
   * 地震を選んでいる間は、気象警報・注意報の塗りを隠す (震度の色と重なって読み違えるため。特別警報は縁取りで残す。
   * docs/map.md の「地震を選んでいる間」)
   */
  const quakeShown = $derived(quake !== undefined);
  /**
   * 地図の箱の高さ (px)。低い地図 (スマホの形の一覧のタブで上に残す地図) では、隠していることの一言が震央や丸を
   * 覆うので出さない。地図のタブへ移って地図が高くなると出す
   */
  let boxHeight = $state(0);
  const NOTE_MIN_HEIGHT = 420;
  // ---- 雨雲 (気象庁の高解像度降水ナウキャストのいま。docs/map.md の「雨雲」) ----
  // 時刻の表をブラウザから直接取り、いまの 1 枚のタイルに差し替える。取るのは雨雲を出している間だけで、
  // 画面が見えていない間 (裏のタブ・閉じた画面) と地震を選んでいる間 (雨雲を隠す) は止める
  /** 雨雲を出しているか (選んでいて、地震を選んでいない) */
  const rainOn = $derived(rainShown(hazard, quakeShown));
  let rainFrame = $state<RainFrame | null>(null);
  /** 最後に時刻の表を取りに行った時刻 (雨雲が古いかを決める) と、そのとき読めなかったか */
  let rainChecked = $state(0);
  let rainFailed = $state(false);
  let pageVisible = $state(true);
  $effect(() => {
    const seen = () => (pageVisible = document.visibilityState === "visible");
    seen();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  });
  $effect(() => {
    if (!map || !rainOn || !pageVisible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 選び直したときと画面に戻ったときは、取れるまでの間も前の雨雲が古いかを今の時刻で決める
    // (長く裏にいた後に、前の雨雲を「5 分ごとに更新」と出さない)
    rainChecked = Date.now();
    const poll = async () => {
      let wait = RAIN_RETRY_MS;
      try {
        // 表は配信の CDN が 60 秒覚える。ブラウザのキャッシュは ETag で確かめ直す
        const r = await fetch(RAIN_TIMES_URL, {
          cache: "no-cache",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          // 返らないまま止まると次を取らないので、10 秒で失敗にして 1 分後に取り直す
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`targetTimes: ${r.status}`);
        const f = latestRain(await r.json());
        if (!f) throw new Error("targetTimes: 観測の時刻がありません");
        if (stopped) return;
        if (f.validtime !== untrack(() => rainFrame?.validtime)) rainFrame = f;
        rainFailed = false;
        wait = nextRainPoll(f, Date.now());
      } catch (err) {
        if (stopped) return;
        console.warn(`雨雲の時刻を読めませんでした: ${err}`);
        rainFailed = true;
      }
      rainChecked = Date.now();
      timer = setTimeout(() => void poll(), wait);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });
  // いまの 1 枚に差し替える (5 分ごと)。段ごとの source の URL を替える
  $effect(() => {
    if (!map || !rainFrame) return;
    const url = rainTiles(rainFrame);
    for (const n of RAIN_TILE_ZOOMS) {
      const src = map.getSource(`rain-${n}`);
      if (src && "setTiles" in src)
        (src as { setTiles(t: string[]): void }).setTiles([url]);
    }
  });
  /** 雨雲が古いか (15 分より前の観測しか取れていない) */
  const rainOld = $derived(
    rainFrame !== null && rainChecked > 0 && rainStale(rainFrame, rainChecked),
  );

  // ---- キキクル (気象庁の土砂・大雨の危険度。docs/map.md の「キキクル」) ----
  // 雨雲と同じく、時刻の表をブラウザから直接取り、いまの 1 枚のタイルに差し替える。取るのはキキクルを出している間だけ
  /** 選んでいるキキクル (土砂・大雨) */
  const chosenRisk = $derived(riskOf(hazard));
  /** キキクルを出しているか (選んでいて、地震を選んでいない) */
  const riskOn = $derived(riskShown(hazard, quakeShown));
  /** いまの 1 枚と、それがどのキキクルのものか (土砂と大雨を選び替えたら、前の 1 枚は使わない) */
  let riskFrame = $state<(RiskFrame & { element: RiskKind["element"] }) | null>(
    null,
  );
  let riskChecked = $state(0);
  let riskFailed = $state(false);
  $effect(() => {
    const element = chosenRisk?.element;
    if (!map || !element || !riskOn || !pageVisible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (untrack(() => riskFrame?.element) !== element) {
      riskFrame = null;
      riskFailed = false;
    }
    riskChecked = Date.now();
    const poll = async () => {
      let wait = RISK_RETRY_MS;
      try {
        const r = await fetch(RISK_TIMES_URL, {
          cache: "no-cache",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`targetTimes: ${r.status}`);
        const f = latestRisk(await r.json(), element);
        if (!f) throw new Error("targetTimes: キキクルの時刻がありません");
        if (stopped) return;
        const now = untrack(() => riskFrame);
        if (
          now?.element !== element ||
          now.validtime !== f.validtime ||
          now.member !== f.member
        )
          riskFrame = { ...f, element };
        riskFailed = false;
        wait = nextRiskPoll(f, Date.now());
      } catch (err) {
        if (stopped) return;
        console.warn(`キキクルの時刻を読めませんでした: ${err}`);
        riskFailed = true;
      }
      riskChecked = Date.now();
      timer = setTimeout(() => void poll(), wait);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });
  // いまの 1 枚に差し替える (10 分ごと・土砂と大雨を選び替えたとき)
  $effect(() => {
    if (!map || !riskFrame) return;
    const url = riskTiles(riskFrame, riskFrame.element);
    for (const n of RISK_TILE_ZOOMS) {
      const src = map.getSource(`risk-${n}`);
      if (src && "setTiles" in src)
        (src as { setTiles(t: string[]): void }).setTiles([url]);
    }
  });
  /** キキクルが古いか (40 分より前の判定しか取れていない) */
  const riskOld = $derived(
    riskFrame !== null && riskChecked > 0 && riskStale(riskFrame, riskChecked),
  );
  /** いまのキキクルの 1 枚が、選んでいるキキクルのものか (選び替えた直後の前の 1 枚は出さない) */
  const riskReady = $derived(
    riskFrame !== null && riskFrame.element === chosenRisk?.element,
  );

  // ---- 雷・竜巻 (気象庁のナウキャストのいまの解析。docs/map.md の「雷・竜巻」) ----
  // キキクルと同じく、時刻の表をブラウザから直接取り、いまの 1 枚に差し替える。取るのは出している間だけ
  /** 選んでいる雷か竜巻 */
  const chosenNowc = $derived(nowcOf(hazard));
  /** 雷・竜巻・今後の雨を出しているか (選んでいて、地震を選んでいない) */
  const nowcOn = $derived(nowcShown(hazard, quakeShown));
  let nowcFrame = $state<(NowcFrame & { element: NowcKind["element"] }) | null>(
    null,
  );
  let nowcChecked = $state(0);
  let nowcFailed = $state(false);
  /**
   * 時刻の表を、出している間だけ取り直す。`pick` は表から 1 枚 (か予測の並び) を選び、`next` は次に取るまでのミリ秒。
   * 返らないまま止まらないよう 10 秒で失敗にし、1 分後に取り直す。止めるときは返した関数を呼ぶ
   */
  function pollTimes(
    url: string,
    use: (raw: unknown) => number,
    fail: () => void,
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let wait = NOWC_RETRY_MS;
      try {
        const r = await fetch(url, {
          cache: "no-cache",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`targetTimes: ${r.status}`);
        const raw: unknown = await r.json();
        if (stopped) return;
        wait = use(raw);
      } catch (err) {
        if (stopped) return;
        console.warn(`気象庁の時刻の表を読めませんでした (${url}): ${err}`);
        fail();
      }
      timer = setTimeout(() => void poll(), wait);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
  $effect(() => {
    const element = chosenNowc?.element;
    if (!map || !element || !nowcOn || !pageVisible) return;
    if (untrack(() => nowcFrame?.element) !== element) {
      nowcFrame = null;
      nowcFailed = false;
    }
    nowcChecked = Date.now();
    return pollTimes(
      N3_TIMES_URL,
      (raw) => {
        const f = latestAnalysis(raw, element);
        nowcChecked = Date.now();
        if (!f) throw new Error("targetTimes: 解析の時刻がありません");
        const now = untrack(() => nowcFrame);
        if (now?.element !== element || now.validtime !== f.validtime)
          nowcFrame = { ...f, element };
        nowcFailed = false;
        return nextN3Poll(f, Date.now());
      },
      () => {
        nowcChecked = Date.now();
        nowcFailed = true;
      },
    );
  });
  $effect(() => {
    if (!map || !nowcFrame) return;
    const url = nowcTiles(nowcFrame, nowcFrame.element);
    for (const n of N3_TILE_ZOOMS) {
      const src = map.getSource(`nowc-${n}`);
      if (src && "setTiles" in src)
        (src as { setTiles(t: string[]): void }).setTiles([url]);
    }
  });
  const nowcOld = $derived(
    nowcFrame !== null && nowcChecked > 0 && nowcStale(nowcFrame, nowcChecked),
  );
  const nowcReady = $derived(
    nowcFrame !== null && nowcFrame.element === chosenNowc?.element,
  );

  // ---- 今後の雨 (気象庁の降水短時間予報。docs/map.md の「今後の雨」) ----
  // 予測の並び (1 時間ごと) を取り、選んでいる何時間先かの 1 枚を出す。時刻は ‹ › で人が動かす (自動では動かさない)
  const forecastChosen = $derived(hazard === "rain-forecast");
  let forecast = $state<NowcFrame[]>([]);
  /** 選んでいる予測 (並びの何番目か)。新しい予測が来ても、何時間先かを保つ */
  let forecastStep = $state(0);
  let forecastChecked = $state(0);
  let forecastFailed = $state(false);
  $effect(() => {
    if (!map || !forecastChosen || !nowcOn || !pageVisible) return;
    forecastChecked = Date.now();
    return pollTimes(
      RASRF_TIMES_URL,
      (raw) => {
        const frames = forecastFrames(raw);
        forecastChecked = Date.now();
        if (frames.length === 0)
          throw new Error("targetTimes: 予測の時刻がありません");
        const now = untrack(() => forecast);
        if (
          now.length !== frames.length ||
          now[0]?.basetime !== frames[0]?.basetime
        )
          forecast = frames;
        forecastFailed = false;
        return RASRF_POLL_MS;
      },
      () => {
        forecastChecked = Date.now();
        forecastFailed = true;
      },
    );
  });
  const forecastFrame = $derived(
    forecast[Math.min(forecastStep, forecast.length - 1)] ?? null,
  );
  $effect(() => {
    if (!map || !forecastFrame) return;
    const url = rasrfTiles(forecastFrame);
    for (const n of RASRF_TILE_ZOOMS) {
      const src = map.getSource(`rasrf-${n}`);
      if (src && "setTiles" in src)
        (src as { setTiles(t: string[]): void }).setTiles([url]);
    }
  });
  const forecastOld = $derived(
    forecastFrame !== null &&
      forecastChecked > 0 &&
      rasrfStale(forecastFrame, forecastChecked),
  );

  // ---- 線状降水帯の雨域 (出ている間だけ、いつも描く。docs/map.md の「線状降水帯」) ----
  // 画面が見えている間は 10 分ごとに時刻の表を取り、いちばん新しい解析の雨域の GeoJSON を読む (無いときは空が返る)
  let slmcsAt = $state<string | null>(null);
  $effect(() => {
    if (!map || !pageVisible) return;
    const m = map;
    let last = "";
    const aborter = new AbortController();
    const clear = () => {
      setData(m, "slmcs", { type: "FeatureCollection", features: [] });
      slmcsAt = null;
    };
    const stop = pollTimes(
      N3_TIMES_URL,
      (raw) => {
        const f = latestAnalysis(raw, "slmcs_unify");
        // 表から雨域が消えたときと、描いている雨域が古いまま新しい解析を読めないときは、古い線を残さない
        const shown = untrack(() => slmcsAt);
        if (shown && Date.now() - Date.parse(shown) > N3_STALE_MS) clear();
        if (!f) {
          last = "";
          if (shown) clear();
          return NOWC_RETRY_MS;
        }
        if (f.validtime !== last) {
          last = f.validtime;
          void fetch(slmcsUrl(f), {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.any([
              aborter.signal,
              AbortSignal.timeout(10_000),
            ]),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j: unknown) => {
              if (aborter.signal.aborted) return;
              if (j === null) {
                last = "";
                return;
              }
              const fc = slmcsFeatures(j);
              setData(m, "slmcs", fc);
              slmcsAt = fc.features.length > 0 ? stampIso(f.validtime) : null;
            })
            .catch(() => {
              // 読めなければ前の雨域のまま、次の時刻の表で読み直す (古くなったら上で消す)
              last = "";
            });
        }
        return nextN3Poll(f, Date.now());
      },
      () => {},
    );
    return () => {
      aborter.abort();
      stop();
    };
  });

  /** 気象警報・注意報の塗りを隠しているか (重ねる図が重なっているか、地震を選んでいるため) */
  const warningsHidden = $derived(
    covered || rainOn || riskOn || nowcOn || quakeShown,
  );
  $effect(() => {
    if (!map) return;
    for (const [layer, on] of Object.entries({
      ...hazardVisibility(hazard),
      ...rainVisibility(hazard, quakeShown, rainFrame !== null),
      ...riskVisibility(hazard, quakeShown, riskReady),
      ...nowcVisibility(hazard, quakeShown, nowcReady),
      ...rasrfVisibility(hazard, quakeShown, forecastFrame !== null),
      ...overlayVisibility(hazard, zoom, quakeShown),
    }))
      map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    // 塗りを隠している間は、塗った所の吹き出しも出さない
    if (warningsHidden) warningPopup?.remove();
  });

  // ---- 住んでいる地域 (通知の条件) の縁取り ----
  $effect(() => {
    if (!map) return;
    const f = homeFilter(alerter.prefs.home?.code) as never;
    map.setFilter("home-casing", f);
    map.setFilter("home-line", f);
  });

  // ---- 地図のメニュー (右クリック・スマホは長押し。docs/map.md の「地図のメニュー」) ----
  /** メニューを出した所 (地図の箱の中の px) と、その緯度・経度 */
  let place = $state<{ x: number; y: number; lat: number; lon: number }>();
  let placeMenu = $state(false);
  /** メニューの操作の結果の知らせ (地図の上の真ん中に少しの間だけ出す) */
  let placeNote = $state("");
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  function openPlace(x: number, y: number, lat: number, lon: number): void {
    place = { x, y, lat, lon };
    // 開いている吹き出しは閉じる (重なって読みにくい)
    closePopups();
    placeMenu = true;
  }

  function showNote(text: string): void {
    placeNote = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (placeNote = ""), 8000);
  }

  /** 住んでいる地域を探して覚えている途中か (続けて押したときに、知らせの文が前後しないよう 1 つずつ) */
  let homeBusy = false;
  /** 押した所が入る市町村等を、住んでいる地域にする (通知の窓の「現在地から選ぶ」と同じ探し方と覚え方) */
  async function setHomeHere(): Promise<void> {
    const at = place;
    if (!at || homeBusy) return;
    homeBusy = true;
    showNote("市町村を探しています…");
    try {
      const home = await homeAt(at.lat, at.lon);
      if (!home) {
        showNote(
          "ここが入る市町村が見つかりませんでした (海の上や日本の外です)。住んでいる地域は変えていません",
        );
        return;
      }
      showNote(await saveHome(home));
    } catch (err) {
      showNote(failureText("住んでいる地域を決められませんでした", err));
    } finally {
      homeBusy = false;
    }
  }

  async function copyCoords(): Promise<void> {
    const at = place;
    if (!at) return;
    const text = coordText(at.lat, at.lon);
    try {
      await navigator.clipboard.writeText(text);
      showNote(`緯度・経度を写しました (${text})`);
    } catch {
      showNote(`写せませんでした。緯度・経度は ${text} です`);
    }
  }

  /** メニューを閉じたら、地図にフォーカスを戻す (目に見えない引き金に残さない) */
  function placeClosed(): void {
    if (container?.contains(document.activeElement) === false)
      map?.getCanvas().focus({ preventScroll: true });
  }

  // 長押しの間に地図が動いていないかを、念のため自分でも見る (MapLibre の長押しは指の動きだけを見る)。
  // 指を置いた所と、置いてから地図が動いたか (慣性で流れている間など)
  let pressAt: { x: number; y: number } | undefined;
  let pressMoved = false;
  const pressStill = (x: number, y: number) =>
    pressAt !== undefined &&
    longPressOk({
      dx: x - pressAt.x,
      dy: y - pressAt.y,
      touches: 1,
      mapMoved: pressMoved,
    });

  $effect(() => {
    const el = container;
    if (!el) return;
    const onstart = (e: TouchEvent) => {
      const t = e.touches[0];
      const r = el.getBoundingClientRect();
      pressAt =
        e.touches.length === 1 && t
          ? { x: t.clientX - r.left, y: t.clientY - r.top }
          : undefined;
      pressMoved = false;
    };
    // マウスの右クリック。指の長押しの contextmenu (Android) は MapLibre が止めて自分で送るので、ここでは見ない
    const oncontext = (e: MouseEvent) => {
      if ((e as PointerEvent).pointerType === "touch" || !map) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const at = map.unproject([x, y]);
      openPlace(x, y, at.lat, at.lng);
    };
    // 地図にフォーカスがあるときの Esc で、開いている吹き出しを閉じる。閉じたら Esc を使ったことにして
    // (`preventDefault`)、読み上げは止めない (メニューと同じく、Esc はこちらが先)
    const onkey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const open = [
        shelterPopup,
        warningPopup,
        stationPopup,
        marinePopupEl,
        roadPopupEl,
      ].some((p) => p?.isOpen());
      if (!open) return;
      closePopups();
      e.preventDefault();
    };
    el.addEventListener("touchstart", onstart, { passive: true });
    el.addEventListener("contextmenu", oncontext);
    el.addEventListener("keydown", onkey);
    return () => {
      clearTimeout(noteTimer);
      el.removeEventListener("touchstart", onstart);
      el.removeEventListener("contextmenu", oncontext);
      el.removeEventListener("keydown", onkey);
    };
  });

  // ---- 指定緊急避難場所・指定避難所 (寄せたときだけ、見ている範囲のタイルを読む) ----
  /** 読んだタイル (層とタイルの組) の中身。同じタイルは読み直さない */
  const shelterCache = new Map<string, Promise<unknown[]>>();
  let shelterSig = "";

  async function loadShelters(): Promise<void> {
    const m = map;
    if (!m || m.getZoom() < SHELTER_MIN_ZOOM - 0.01) return;
    const b = m.getBounds();
    const tiles = tilesIn(
      [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      SHELTER_TILE_ZOOM,
    );
    const next = sig(tiles);
    if (next === shelterSig) return;
    shelterSig = next;
    let missed = false;
    const parts = await Promise.all(
      tiles.flatMap(([x, y]) =>
        SHELTER_LAYERS.map(async (layer) => {
          const url = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${SHELTER_TILE_ZOOM}/${x}/${y}.geojson`;
          let p = shelterCache.get(url);
          if (!p) {
            // タイルの無い所 (海など) は 404。そこは空
            p = fetch(url)
              .then((r) => (r.ok ? r.json() : { features: [] }))
              .then((j: { features?: unknown[] }) => j.features ?? [])
              .catch(() => {
                shelterCache.delete(url);
                missed = true;
                return [];
              });
            shelterCache.set(url, p);
          }
          return { layer, features: (await p) as never[] };
        }),
      ),
    );
    if (shelterSig !== next) return;
    // 読めなかったタイルがあれば、同じ範囲のまま次に動かしたときも読み直す (通信が不安定なときに出ないままにしない)
    if (missed) shelterSig = "";
    if (map)
      setData(map, "shelters", {
        type: "FeatureCollection",
        features: mergeShelters(parts),
      });
  }

  /**
   * 避難場所の印。ふつうは緑の角丸の四角に白い「避」、福祉避難所は白い角丸の四角に緑の太い縁と緑の「福」
   * (地と字の色を入れ替えて、遠目にも見分けられるようにする)。端末の字体で 1 度だけ描く
   */
  function shelterIcon(welfare: boolean): ImageData {
    const s = 40;
    const c = document.createElement("canvas");
    c.width = s;
    c.height = s;
    const g = c.getContext("2d");
    if (!g) return new ImageData(s, s);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.roundRect(0, 0, s, s, 9);
    g.fill();
    g.fillStyle = "#00873c";
    g.beginPath();
    g.roundRect(3, 3, s - 6, s - 6, 7);
    g.fill();
    if (welfare) {
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.roundRect(7, 7, s - 14, s - 14, 4);
      g.fill();
    }
    g.fillStyle = welfare ? "#00873c" : "#ffffff";
    g.font = `bold ${welfare ? 20 : 24}px ${TEXT_FONT_CSS}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(welfare ? "福" : "避", s / 2, s / 2 + 1);
    return g.getImageData(0, 0, s, s);
  }

  /** 押した避難場所の名前・住所と、どの災害に対応するか。文は DOM で組み、HTML として読まない */
  let shelterPopup: Popup | undefined;

  /**
   * 吹き出しの形。隅の出典と右下の操作の側へは開かず、反対の向きに開く。スマホの形の dock と下のタブは
   * 操作のすぐ下にあり、地図の下の端から操作の上の端までをまとめて空けるので、別に測らない (操作はいつもある)
   */
  let creditEl = $state<HTMLAnchorElement>();
  let controlsEl = $state<HTMLDivElement>();
  function popupOptions(): {
    maxWidth: string;
    closeButton: boolean;
    padding?: Box;
  } {
    const box = container?.getBoundingClientRect();
    return {
      maxWidth: "18rem",
      closeButton: false,
      padding: box
        ? edgePadding(box, [
            creditEl?.getBoundingClientRect(),
            controlsEl?.getBoundingClientRect(),
          ])
        : undefined,
    };
  }
  function openShelter(p: Record<string, unknown>, at: LngLat): void {
    if (!map || !PopupClass) return;
    // MapLibre は GeoJSON の配列を文字列にして渡してくる
    const disasters = (
      typeof p.disasters === "string"
        ? (JSON.parse(p.disasters) as number[])
        : ((p.disasters as number[]) ?? [])
    ).map((i) => SHELTER_DISASTERS[i - 1]);
    const box = document.createElement("div");
    box.className = "shelter-pop";
    const line = (text: string, cls = "") => {
      const el = document.createElement("p");
      el.textContent = text;
      if (cls) el.className = cls;
      box.append(el);
    };
    line(String(p.name ?? ""), "bold");
    if (p.address) line(String(p.address), "small muted");
    if (disasters.length > 0)
      line(`指定緊急避難場所: ${disasters.join("、")}`, "small");
    if (p.shelter === true || p.shelter === "true") line("指定避難所", "small");
    if (p.welfare === true || p.welfare === "true") {
      line(
        p.accept
          ? `福祉避難所 (受け入れる人: ${String(p.accept)})`
          : "福祉避難所",
        "small",
      );
      line(
        "配慮の要る人のための避難所で、受け入れる人が決まっています。",
        "tiny muted",
      );
    }
    line(
      "国土地理院のデータで、最新でないことがあります。避難先は市町村の情報で確かめてください。",
      "tiny muted",
    );
    closePopups();
    shelterPopup = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  /**
   * 押した市町村等の名前と、いま出ている警報・注意報 (重い順)、発表した府県予報区と時刻、詳しい内容へのリンク。
   * 段のラベルは WarningLevel.svelte と同じ形と色。文は DOM で組み、HTML として読まない
   */
  let warningPopup: Popup | undefined;
  function openWarning(code: string, at: LngLat): void {
    // ハザードマップを重ねている間と地震を選んでいる間は塗りを隠しているので、吹き出しも出さない
    if (!map || !PopupClass || warningsHidden) return;
    const c = cityWarnings(warnings, code);
    if (!c) return;
    const box = document.createElement("div");
    box.className = "warning-pop";
    box.dataset.testid = "warning-pop";
    const name = document.createElement("p");
    name.className = "bold";
    name.textContent = c.name;
    const list = document.createElement("ul");
    list.className = "warning-kinds";
    for (const k of c.kinds) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      const color = WARNING_COLORS[k.level];
      label.className = "level-label";
      label.textContent = kindText(k.name);
      if (color) {
        label.style.background = color.bg;
        label.style.color = color.fg;
      }
      li.append(label);
      list.append(li);
    }
    const from = document.createElement("p");
    from.className = "small muted";
    from.textContent = `${c.office.name}・${jstFull(c.reportedAt)} 発表`;
    box.append(name, list, from);
    if (officeHref) {
      const link = document.createElement("a");
      link.className = "small";
      link.href = officeHref(c.office.code);
      link.textContent = `${c.office.name}の警報・注意報を見る`;
      link.addEventListener("click", () => {
        warningPopup?.remove();
        onoffice?.();
      });
      const p = document.createElement("p");
      p.append(link);
      box.append(p);
    }
    closePopups();
    warningPopup = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  /** マウスを乗せると指の形にする層 (押すと吹き出しを出すか、地震を選ぶ。警報・注意報の面は塗った所だけなので別) */
  const POINTER_LAYERS = [
    "shelters",
    "intensity-stations",
    "marine",
    "typhoon-center",
    "road-closed",
    "road-speed",
    "hypocenters",
    "foreign",
  ];

  /**
   * 押した所の震源の丸 (国内の地震と海外の地震)。押せる範囲は観測点の丸と同じく指 22px・マウス 10px で、丸がそれより
   * 大きいときは丸の中ならどこでも。範囲に幾つもあるときは押した所にいちばん近いもの (`nearestEpicenter`)
   */
  function epicenterHit(
    pt: { x: number; y: number },
    ev: MouseEvent | TouchEvent | undefined,
  ): EpicenterHit | undefined {
    const m = map;
    if (!m?.getLayer("hypocenters") || !m.getLayer("foreign")) return undefined;
    const kind = (ev as PointerEvent | undefined)?.pointerType;
    const reach = epicenterReach(
      kind === "touch" ||
        (typeof TouchEvent !== "undefined" && ev instanceof TouchEvent) ||
        (!kind &&
          typeof matchMedia === "function" &&
          matchMedia("(pointer: coarse)").matches),
    );
    const hits = m
      .queryRenderedFeatures(
        [
          [pt.x - reach, pt.y - reach],
          [pt.x + reach, pt.y + reach],
        ],
        { layers: ["hypocenters", "foreign"] },
      )
      .flatMap((f): EpicenterHit[] => {
        if (f.geometry.type !== "Point") return [];
        const id = f.properties?.id;
        if (typeof id !== "string") return [];
        const p = m.project(f.geometry.coordinates as [number, number]);
        const foreignOne = f.layer.id === "foreign";
        return [
          {
            kind: foreignOne ? "foreign" : "quake",
            id,
            d2: (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2,
            radius: radiusAt(
              foreignOne ? FOREIGN_RADIUS : HYPO_RADIUS,
              Number(f.properties?.m ?? 0),
            ),
            order: Number(f.properties?.order ?? 0),
          },
        ];
      });
    return nearestEpicenter(hits, reach);
  }

  /** 地図の上の吹き出しを全部閉じる (1 つだけ出す) */
  function closePopups(): void {
    shelterPopup?.remove();
    warningPopup?.remove();
    stationPopup?.remove();
    marinePopupEl?.remove();
    typhoonPopupEl?.remove();
    roadPopupEl?.remove();
  }

  /**
   * 押した所の観測点の丸。丸は小さい (半径 2.5〜9 px) ので、押せる範囲を丸より広く取る。指は 44px 四方
   * (denpa の design.md の押せる大きさ)、マウスは 20px 四方。範囲に幾つもあるときは押した所にいちばん近いもの
   */
  function stationHit(
    pt: { x: number; y: number },
    ev: MouseEvent | TouchEvent | undefined,
  ): { properties: Record<string, unknown>; at: [number, number] } | undefined {
    const m = map;
    if (!m?.getLayer("intensity-stations")) return undefined;
    const kind = (ev as PointerEvent | undefined)?.pointerType;
    const touch =
      kind === "touch" ||
      (typeof TouchEvent !== "undefined" && ev instanceof TouchEvent) ||
      (!kind &&
        typeof matchMedia === "function" &&
        matchMedia("(pointer: coarse)").matches);
    const r = touch ? 22 : 10;
    const hits = m
      .queryRenderedFeatures(
        [
          [pt.x - r, pt.y - r],
          [pt.x + r, pt.y + r],
        ],
        { layers: ["intensity-stations"] },
      )
      .flatMap((f) => {
        if (f.geometry.type !== "Point") return [];
        const at = f.geometry.coordinates as [number, number];
        const p = m.project(at);
        const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
        return d2 <= r * r
          ? [
              {
                properties: f.properties as Record<string, unknown>,
                at,
                d2,
                order: Number(f.properties?.order ?? 0),
              },
            ]
          : [];
      });
    return nearestStation(hits);
  }

  /**
   * 押した観測点の名前・震度・都道府県と市町村・設置者 (`stationPopup` が組んだ中身)。震度のラベルは一覧の
   * 震度 (Intensity.svelte) と同じ色。文は DOM で組み、HTML として読まない
   */
  let stationPopup: Popup | undefined;
  function openStation(p: Record<string, unknown>, at: [number, number]): void {
    if (!map || !PopupClass) return;
    const box = document.createElement("div");
    box.className = "station-pop";
    box.dataset.testid = "station-pop";
    const name = document.createElement("p");
    name.className = "bold";
    name.textContent = String(p.name ?? "");
    const int = document.createElement("p");
    const label = document.createElement("span");
    const c = INTENSITY_COLORS[String(p.int ?? "")];
    label.className = "level-label";
    label.textContent = String(p.label ?? "");
    if (c) {
      label.style.background = c.bg;
      label.style.color = c.fg;
    }
    int.append(label);
    box.append(name, int);
    for (const text of [p.place, p.owner]) {
      if (!text) continue;
      const el = document.createElement("p");
      el.className = "small muted";
      el.textContent = String(text);
      box.append(el);
    }
    closePopups();
    stationPopup = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  // ---- 海しるの点 (海底地殻変動観測点・海域火山。docs/map.md の「海しるの点」) ----
  /** サーバーが 1 日 1 回取って置いたものを 1 度だけ読む。キーの無いサーバーでは空 (層を出さない) */
  async function loadMarine(m: MapLibreMap): Promise<void> {
    try {
      const r = await fetch(MARINE_URL);
      if (!r.ok) return;
      const body = (await r.json()) as MarineResponse;
      if (body.enabled && map === m) setData(m, "marine", body.data);
    } catch {
      // 読めなくても地図はそのまま (点を出さないだけ)
    }
  }

  /** 押した所の海しるの点。観測点の丸と同じく、押せる範囲は点より広い (指 22px・マウス 10px) */
  function marineHit(
    pt: { x: number; y: number },
    ev: MouseEvent | TouchEvent | undefined,
  ): { properties: MarinePoint; at: [number, number] } | undefined {
    const m = map;
    if (!m?.getLayer("marine")) return undefined;
    const kind = (ev as PointerEvent | undefined)?.pointerType;
    const r =
      kind === "touch" ||
      (!kind &&
        typeof matchMedia === "function" &&
        matchMedia("(pointer: coarse)").matches)
        ? 22
        : 10;
    const hits = m
      .queryRenderedFeatures(
        [
          [pt.x - r, pt.y - r],
          [pt.x + r, pt.y + r],
        ],
        { layers: ["marine"] },
      )
      .flatMap((f) => {
        if (f.geometry.type !== "Point") return [];
        const at = f.geometry.coordinates as [number, number];
        const p = m.project(at);
        const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
        return d2 <= r * r
          ? [{ properties: f.properties as MarinePoint, at, d2 }]
          : [];
      });
    return nearestMarine(hits);
  }

  /** 押した点の名前・種類・水深か標高など (`marinePopup` が組んだ中身)。文は DOM で組み、HTML として読まない */
  let marinePopupEl: Popup | undefined;
  function openMarine(p: MarinePoint, at: [number, number]): void {
    if (!map || !PopupClass) return;
    const box = document.createElement("div");
    box.className = "station-pop";
    box.dataset.testid = "marine-pop";
    for (const line of marinePopup(p)) {
      const el = document.createElement("p");
      if (line.cls) el.className = line.cls;
      if (line.href) {
        const a = document.createElement("a");
        a.href = line.href;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = line.text;
        el.append(a);
      } else el.textContent = line.text;
      box.append(el);
    }
    closePopups();
    marinePopupEl = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  // ---- 台風の中心 (docs/map.md の「台風」) ----
  /** 押した所の台風の中心か予報円の中心。海しるの点と同じく、押せる範囲は点より広い (指 22px・マウス 10px) */
  function typhoonHit(
    pt: { x: number; y: number },
    ev: MouseEvent | TouchEvent | undefined,
  ): { properties: TyphoonPoint; at: [number, number] } | undefined {
    const m = map;
    if (!m?.getLayer("typhoon-center")) return undefined;
    const kind = (ev as PointerEvent | undefined)?.pointerType;
    const r =
      kind === "touch" ||
      (!kind &&
        typeof matchMedia === "function" &&
        matchMedia("(pointer: coarse)").matches)
        ? 22
        : 10;
    const hits = m
      .queryRenderedFeatures(
        [
          [pt.x - r, pt.y - r],
          [pt.x + r, pt.y + r],
        ],
        { layers: ["typhoon-center"] },
      )
      .flatMap((f) => {
        if (f.geometry.type !== "Point") return [];
        const at = f.geometry.coordinates as [number, number];
        const p = m.project(at);
        const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
        const props = f.properties as TyphoonPoint;
        return d2 <= r * r
          ? [{ properties: props, at, d2, index: Number(props.index) }]
          : [];
      });
    return nearestTyphoonPoint(hits);
  }

  /** 押した中心の名前・号数・中心気圧・最大風速・予報の時刻 (`typhoonPopup` が組んだ中身)。DOM で組み、HTML として読まない */
  let typhoonPopupEl: Popup | undefined;
  function openTyphoon(p: TyphoonPoint, at: [number, number]): void {
    const w = typhoonById.get(String(p.id));
    if (!map || !PopupClass || !w) return;
    const box = document.createElement("div");
    box.className = "station-pop";
    box.dataset.testid = "typhoon-pop";
    for (const line of typhoonPopup(w, Number(p.index), jst)) {
      const el = document.createElement("p");
      if (line.cls) el.className = line.cls;
      el.textContent = line.text;
      box.append(el);
    }
    closePopups();
    typhoonPopupEl = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  // ---- 災害時の通行止めと通れた道 (目安)。docs/map.md の「災害時の通行止め」 ----
  /** 通れた道 (目安) の線を出しているか (ハザードマップの凡例の下で、隠していることを書くため) */
  let roadSpeedShown = $state(false);
  /**
   * サーバーが 30 分ごとに取って置いたものを読み、開いている間は 10 分ごとに読み直す。
   * URL を登録していないサーバーでは空 (層を出さない)
   */
  async function loadRoads(m: MapLibreMap): Promise<void> {
    try {
      const r = await fetch(ROADS_URL);
      if (r.ok) {
        const body = (await r.json()) as RoadResponse;
        if (map !== m) return;
        setData(m, "roads", body.data);
        roadSpeedShown = body.data.features.some(
          (f) => f.properties.kind === "speed",
        );
        if (!body.enabled) return;
      }
    } catch {
      // 読めなくても地図はそのまま (次の回にまた読む)
    }
    setTimeout(() => {
      if (map === m) void loadRoads(m);
    }, ROADS_REFRESH_MS);
  }

  /** 押した所の線。通行止めを先に見る。線は細いので、押せる範囲は指 22px・マウス 8px */
  function roadHit(
    pt: { x: number; y: number },
    ev: MouseEvent | TouchEvent | undefined,
  ): RoadLine | undefined {
    const m = map;
    if (!m?.getLayer("road-closed")) return undefined;
    const kind = (ev as PointerEvent | undefined)?.pointerType;
    const r =
      kind === "touch" ||
      (!kind &&
        typeof matchMedia === "function" &&
        matchMedia("(pointer: coarse)").matches)
        ? 22
        : 8;
    const box: [[number, number], [number, number]] = [
      [pt.x - r, pt.y - r],
      [pt.x + r, pt.y + r],
    ];
    for (const layer of ["road-closed", "road-speed"]) {
      if (m.getLayoutProperty(layer, "visibility") === "none") continue;
      const f = m.queryRenderedFeatures(box, { layers: [layer] })[0];
      if (f) return f.properties as RoadLine;
    }
    return undefined;
  }

  /** 押した線の路線名・区間・規制の内容・更新の時刻 (`roadPopup` が組んだ中身)。文は DOM で組む */
  let roadPopupEl: Popup | undefined;
  function openRoad(p: RoadLine, at: LngLat): void {
    if (!map || !PopupClass) return;
    const box = document.createElement("div");
    box.className = "station-pop";
    box.dataset.testid = "road-pop";
    for (const line of roadPopup(p)) {
      const el = document.createElement("p");
      if (line.cls) el.className = line.cls;
      el.textContent = line.text;
      box.append(el);
    }
    closePopups();
    roadPopupEl = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  /** 震央の ×。MapLibre は印の要素そのものの transform で場所を決めるので、脈打たせるのは中の要素 */
  function epicenter(title: string, eew: boolean): HTMLElement {
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    inner.className = eew ? "epicenter eew" : "epicenter";
    outer.title = title;
    outer.append(inner);
    return outer;
  }

  /**
   * 範囲へ寄せるときの余白 (px)。下は右下のハザードマップの選択と現在地のボタンと隅の出典、
   * スマホの形の下は浮いている下のタブと dock の分を空ける
   */
  function focusPadding(): Box {
    const phone = document.documentElement.hasAttribute("data-phone");
    const h = container?.clientHeight ?? 0;
    const top = 24;
    const bottom = phone ? 210 : 90;
    // 地図が低すぎて余白が収まらないときは、余白を詰める (cameraForBounds が寄せ先を返さなくなる)
    const k = h > 0 ? Math.min(1, (h * 0.6) / (top + bottom)) : 1;
    return {
      top: top * k,
      bottom: bottom * k,
      left: 24,
      right: 24,
    };
  }

  // ---- 検索の欄で選んだ場所 (寄せて小さい印を置く。docs/map.md の「場所の検索」) ----
  let foundMarker: Marker | undefined;
  let foundN = 0;
  $effect(() => {
    if (!map || !MarkerClass) return;
    if (!found) {
      foundMarker?.remove();
      foundMarker = undefined;
      return;
    }
    if (found.n === foundN) return;
    foundN = found.n;
    const p = found.place;
    // 人が探して寄せた所なので、詳しい内容を閉じても元の位置へ戻さない
    untrack(() => keeper.moved());
    // スマホの形で地図のタブへ移るのと同時なので、地図の箱の大きさを測り直してから寄せる
    map.resize();
    if (p.bounds) {
      // 市町村は外枠が収まるように (寄せすぎない)
      const cam = map.cameraForBounds(
        [
          [p.bounds[0], p.bounds[1]],
          [p.bounds[2], p.bounds[3]],
        ],
        { padding: focusPadding() },
      );
      map.jumpTo(
        cam
          ? { ...cam, zoom: Math.min(cam.zoom ?? 11, 13) }
          : { center: p.at, zoom: 11 },
      );
    } else {
      // 住所は街区の代表の点なので、家のまわりが分かるくらいまで
      map.jumpTo({ center: p.at, zoom: Math.max(map.getZoom(), 16) });
    }
    foundMarker?.remove();
    const el = document.createElement("div");
    el.className = "found-mark";
    el.title = p.label;
    el.setAttribute("aria-label", `探した場所 ${p.label}`);
    el.setAttribute("role", "img");
    foundMarker = new MarkerClass({ element: el }).setLngLat(p.at).addTo(map);
  });

  // 出ている緊急地震速報・選んだ火山・海外の地震・府県予報区・地震の順に、先にあるものへ寄せる。飛ばさない。
  // 続報で中身が変わるたびに寄せ直すと、見ている所が勝手に動くので、寄せるのは寄せ先が替わったときだけ。
  // スマホの形は一覧のタブでも地図を上に残すので、選んだときに寄せれば地図のタブでも見えている
  let focused = "";
  /** 詳しい内容を開く前の地図の位置 (閉じたら戻す。`#lib/map/restore.ts`) */
  const keeper = new ViewKeeper();
  /** いまの地図の位置 */
  function viewOf(m: MapLibreMap): MapView {
    const c = m.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: m.getZoom(),
      bearing: m.getBearing(),
      pitch: m.getPitch(),
    };
  }
  /** 選んだものへ寄せる直前に、詳しい内容を開いていれば、いまの位置を控える (開いたまま移ったときは最初のまま) */
  function remember(): void {
    if (map)
      keeper.focus(
        viewOf(map),
        untrack(() => selected),
      );
  }
  $effect(() => {
    if (!map) return;
    const eew = eews.find((e) => !e.cancelled);
    // 選んだ火山の報があれば、その火山へ (緊急地震速報が出ている間はそちらが先)
    const vm =
      !eew && volcano
        ? volcanoMarks([], volcano, volcanoPoints).find((m) => m.selected)
        : undefined;
    // 選んだ海外の地震は、日本から遠いことが多いので、寄せずに引いて見せる
    const fq = !eew && !vm ? foreignQuake : null;
    // 選んだ府県予報区は、警報・注意報の出ている市町村等が画面に収まるように (表を読むまでは待つ)
    const ob =
      !eew && !vm && !fq && office && offices
        ? officeBounds(
            offices,
            office,
            warnings
              .filter((w) => w.status === "normal" && w.office.code === office)
              .flatMap((w) => w.areas.map((a) => a.code)),
          )
        : undefined;
    // 選んだ台風は、いまの強風域と予報円・暴風警戒域が収まるように (続報では寄せ直さない)
    const ty = !eew && !vm && !fq && !office ? typhoon : null;
    const key = eew
      ? `eew:${eew.eventId}`
      : vm
        ? `volcano:${volcano?.id}`
        : fq
          ? `foreign:${fq.id}`
          : office
            ? `office:${office}`
            : ty
              ? `typhoon:${ty.series}`
              : `quake:${quake?.id ?? ""}`;
    if (ty) {
      if (key === focused) return;
      // 5 日先の予報円は大きいので、低い地図 (スマホの形の一覧のタブ) で全部を収めると世界が見えるほど引いてしまう。
      // ズーム 3.5 に収まらなければ、72 時間後・24 時間後までに縮めて、いまの中心に近い所を見せる
      const m = map;
      const camFor = (h: number) => {
        const b = typhoonBounds(ty, h);
        return b
          ? m.cameraForBounds(
              [
                [b[0], b[1]],
                [b[2], b[3]],
              ],
              { padding: focusPadding() },
            )
          : undefined;
      };
      const cam = [Number.POSITIVE_INFINITY, 72, 24]
        .map(camFor)
        .find((c, i, all) => (c?.zoom ?? 0) >= 3.5 || i === all.length - 1);
      if (!cam) return;
      focused = key;
      remember();
      // 小さな熱帯低気圧でも寄せすぎない (まわりの陸が分かるように)
      map.jumpTo({
        ...cam,
        zoom: Math.max(3.5, Math.min(cam.zoom ?? 5, 6)),
      });
      return;
    }
    if (office && !eew && !vm && !fq) {
      if (!ob) return;
      if (key === focused) return;
      const cam = map.cameraForBounds(ob, { padding: focusPadding() });
      if (!cam) return;
      focused = key;
      remember();
      // 小さな市町村 1 つでも寄せすぎない (まわりが分かるように)
      map.jumpTo({ ...cam, zoom: Math.min(cam.zoom ?? 9, 10) });
      return;
    }
    const h = eew?.hypocenter ?? (vm || fq ? undefined : quake?.hypocenter);
    const at: [number, number] | undefined = vm
      ? vm.at
      : fq
        ? [fq.lon, fq.lat]
        : h?.lat !== undefined && h.lon !== undefined
          ? [h.lon, h.lat]
          : undefined;
    if (!at) return;
    const center: [number, number] = at;
    if (key === focused) return;
    focused = key;
    remember();
    map.jumpTo({ center, zoom: fq ? 4 : Math.max(map.getZoom(), 5.5) });
  });
  // 詳しい内容を閉じたら、開く前の位置へ戻す (寄せるときと同じく飛ばさずに jumpTo)。開いている間に人が
  // 動かしたら戻さない。出ている緊急地震速報があるときも戻さない (震央を見せたままにする)
  $effect(() => {
    if (!map || selected || !keeper.open) return;
    const back = keeper.close();
    if (untrack(() => eews.some((e) => !e.cancelled))) return;
    // 閉じたので、同じものをもう一度開いたら寄せ直す
    focused = "";
    if (back) map.jumpTo(back);
  });
</script>

{#if failed}
  <div class="map-failed empty-state"><p class="muted">{failed}</p></div>
{:else}
  <div class="map-box" bind:clientHeight={boxHeight}>
    <div
      class="map"
      bind:this={container}
      role="region"
      aria-label="地図"
    ></div>
    <!--
      地図の上に置く操作は、ハザードマップの選択と現在地のボタンだけ (docs/design.md の 6.2)。
      どちらも右下に、隅の出典の上にまとめる。並びは下から、操作の 1 行・凡例・知らせ (column-reverse)
    -->
    <div class="controls" bind:this={controlsEl} data-testid="map-controls">
      <div class="control-row">
        <!-- マウスを乗せただけで選択肢を開く ((hover: hover) の端末だけ)。外れたら少し待って閉じる -->
        <div
          class="hazard"
          role="presentation"
          onpointerenter={hazardEnter}
          onpointerleave={hazardLeave}
        >
          <Menu
            bind:open={hazardMenu}
            side="top"
            align="end"
            focusOnOpen={hazardBy !== "hover"}
            onclosed={() => (hazardBy = "")}
          >
            {#snippet trigger(props)}
              <button
                {...props}
                type="button"
                class="map-pill"
                data-on={hazard !== "none" ? "" : undefined}
                disabled={!map}
                data-testid="hazard"
                onclick={hazardClick}
              >
                {chosenHazard
                  ? chosenHazard.pill
                  : chosenRisk
                    ? `キキクル: ${chosenRisk.label.replace(/ \(.*\)$/, "")}`
                    : chosenNowc
                      ? chosenNowc.pill
                      : hazard === "rain-forecast"
                        ? "今後の雨 (予測)"
                        : hazard === "rain"
                          ? "雨雲"
                          : "重ねる: なし"}
              </button>
            {/snippet}
            <!-- 重ねる図は 1 つだけ (色がぶつかるため)。雨雲・キキクルといまのハザードマップを同じ選択に並べる -->
            <button
              type="button"
              role="menuitemradio"
              class="menu-item"
              aria-checked={hazard === "none"}
              onclick={() => pickHazard("none")}
              data-testid="hazard-none">なし</button
            >
            <p class="menu-head">雨・雷・竜巻</p>
            {#each [{ id: "rain" as const, label: "雨雲 (いま)" }, { id: "rain-forecast" as const, label: "今後の雨 (予測)" }, ...NOWC_KINDS] as h (h.id)}
              <button
                type="button"
                role="menuitemradio"
                class="menu-item"
                aria-checked={hazard === h.id}
                onclick={() => pickHazard(h.id)}
                data-testid="hazard-{h.id}">{h.label}</button
              >
            {/each}
            <p class="menu-head">キキクル (危険度分布)</p>
            {#each RISKS as r (r.id)}
              <button
                type="button"
                role="menuitemradio"
                class="menu-item"
                aria-checked={hazard === r.id}
                onclick={() => pickHazard(r.id)}
                data-testid="hazard-{r.id}">{r.label}</button
              >
            {/each}
            <!-- 洪水の浸水が続く時間と家屋倒壊等は、選択肢に並べずに洪水の凡例の上で切り替える (docs/map.md) -->
            {#each HAZARD_GROUPS as g (g.id)}
              <p class="menu-head">{g.label}</p>
              {#each HAZARD_CHOICES.filter((h) => h.group === g.id) as h (h.id)}
                <button
                  type="button"
                  role="menuitemradio"
                  class="menu-item"
                  aria-checked={hazardChoice(hazard) === h.id}
                  onclick={() => pickHazard(h.id)}
                  data-testid="hazard-{h.id}">{h.label}</button
                >
              {/each}
            {/each}
          </Menu>
        </div>
        <button
          type="button"
          class="locate-button"
          aria-pressed={paused ? "mixed" : locating !== "off"}
          aria-label={paused
            ? "現在地の表示はオンです (押すと位置を探します)"
            : locating === "off"
              ? "現在地を表示"
              : locating === "waiting"
                ? "現在地を探しています (押すとやめる)"
                : "現在地の表示をやめる"}
          title={paused
            ? "現在地の表示はオンです。押すと位置を探します"
            : locating === "off"
              ? "現在地を表示"
              : "現在地の表示をやめる"}
          onclick={toggleLocate}
          disabled={!map}
          data-locating={paused ? "paused" : locating}
          data-testid="locate"
        >
          <Icon icon={locating === "on" ? LocateFixed : Locate} />
        </button>
      </div>
      {#if chosenHazard}
        <!-- 公式の凡例 (ハザードマップポータルサイトと J-SHIS の画像)。活断層は凡例の代わりに国土地理院の説明へのリンク -->
        <figure class="legend" data-testid="hazard-legend">
          <figcaption class="small bold">{chosenHazard.title}</figcaption>
          {#if family.length > 0}
            <!-- 洪水の図の切り替え (浸水の深さ・浸水が続く時間・家屋倒壊等)。1 つだけ選ぶ並び -->
            <div class="chips variants" role="group" aria-label="洪水の図">
              {#each family as v (v.id)}
                <button
                  type="button"
                  class="chip"
                  aria-pressed={hazard === v.id}
                  onclick={() => pickHazard(v.id)}
                  data-testid="hazard-variant-{v.id}">{v.variant}</button
                >
              {/each}
            </div>
          {/if}
          {#each chosenHazard.legends as l (l.src)}
            {#if l.name}<p class="tiny">{l.name}</p>{/if}
            <img src={l.src} alt={l.alt} loading="lazy" />
          {/each}
          {#if chosenHazard.about}
            <p class="tiny">
              {#each chosenHazard.about as part, i (i)}{#if typeof part === "string"}{part}{:else}<a
                    href={part.href}
                    target="_blank"
                    rel="noopener">{part.text}</a
                  >{/if}{/each}
            </p>
          {/if}
          {#if chosenHazard.source}
            <p class="tiny muted">
              出典: <a
                href={chosenHazard.source.href}
                target="_blank"
                rel="noopener">{chosenHazard.source.text}</a
              >。{chosenHazard.caveat ?? ""}
            </p>
          {/if}
          <!-- 隠している層があることと、戻し方。図が重ならないズーム (活断層の 11 未満) では隠さない -->
          {#if covered}
            <p class="tiny muted" data-testid="hazard-hidden">
              色がぶつからないよう、警報・注意報と震度の塗り{roadSpeedShown
                ? "・通れた道 (目安) の線"
                : ""}を隠しています
              (特別警報・緊急地震速報は縁取りで出します)。「なし」に戻すと元に戻ります。
            </p>
          {:else}
            <p class="tiny muted" data-testid="hazard-hidden">
              寄せて図が重なると、色がぶつからないよう、警報・注意報と震度の塗り{roadSpeedShown
                ? "・通れた道 (目安) の線"
                : ""}を隠します。
            </p>
          {/if}
        </figure>
      {/if}
      {#if hazard === "rain"}
        <!--
          雨雲の凡例と、いつの観測か。古い雨雲をいまの雨と取り違えないよう、時刻をいつも出す。
          地震を選んでいる間は雨雲を隠すので、そのことと戻し方だけを書く (低い地図では出さない)
        -->
        {#if rainOn}
          <figure class="legend rain-legend" data-testid="rain-legend">
            <figcaption class="small bold">雨雲 (降水強度 mm/h)</figcaption>
            {#if rainFrame}
              <p class="small rain-time" data-testid="rain-time">
                {#if rainOld}
                  <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                  {jst(rainIso(rainFrame))} の観測です。新しい雨雲を読めていないため、いまの雨ではありません
                {:else}
                  {jst(rainIso(rainFrame))} の観測 (5 分ごとに更新)
                {/if}
              </p>
            {:else if rainFailed}
              <p class="small rain-time" data-testid="rain-time">
                <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                雨雲を読み込めませんでした。1 分後に再試行します
              </p>
            {:else}
              <p class="small muted" data-testid="rain-time">
                読み込んでいます…
              </p>
            {/if}
            <ul class="rain-scale">
              {#each RAIN_LEGEND as l (l.label)}
                <li>
                  <span class="rain-swatch" style:background={l.color}
                  ></span><span class="tiny">{l.label}</span>
                </li>
              {/each}
            </ul>
            <p class="tiny muted">
              出典: <a href={RAIN_PAGE} target="_blank" rel="noopener"
                >{RAIN_CREDIT}</a
              >。先の雨は「今後の雨 (予測)」で見られます。
            </p>
            <p class="tiny muted" data-testid="hazard-hidden">
              色がぶつからないよう、警報・注意報の塗り{roadSpeedShown
                ? "・通れた道 (目安) の線"
                : ""}を隠しています
              (特別警報・緊急地震速報は縁取りで出します)。「なし」に戻すと元に戻ります。
            </p>
          </figure>
        {:else if boxHeight >= NOTE_MIN_HEIGHT}
          <p class="map-note tiny muted" data-testid="quake-hides-rain">
            地震を選んでいる間は、雨雲{warningsPainted
              ? "と気象警報・注意報の塗り"
              : ""}を隠しています (震度の色と重なるため){specialPainted
              ? "。特別警報は縁取りで出します"
              : ""}。一覧へ戻ると元に戻ります。
          </p>
        {/if}
      {/if}
      {#if chosenRisk}
        <!--
          キキクルの凡例と、いつの判定か。古い危険度をいまの危険度と取り違えないよう、時刻をいつも出す。
          地震を選んでいる間はキキクルを隠すので、そのことと戻し方だけを書く (低い地図では出さない)
        -->
        {#if riskOn}
          <figure class="legend rain-legend" data-testid="risk-legend">
            <figcaption class="small bold">{chosenRisk.title}</figcaption>
            {#if riskFrame && riskReady}
              <p class="small rain-time" data-testid="risk-time">
                {#if riskOld}
                  <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                  {jst(riskIso(riskFrame))} の危険度です。新しいキキクルを読めていないため、いまの危険度ではありません
                {:else}
                  {jst(riskIso(riskFrame))} の危険度 (10 分ごとに更新)
                {/if}
              </p>
            {:else if riskFailed}
              <p class="small rain-time" data-testid="risk-time">
                <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                キキクルを読み込めませんでした。1 分後に再試行します
              </p>
            {:else}
              <p class="small muted" data-testid="risk-time">
                読み込んでいます…
              </p>
            {/if}
            <ul class="risk-scale">
              {#each RISK_LEGEND as l (l.label)}
                <li>
                  <span class="rain-swatch" style:background={l.color}
                  ></span><span class="tiny"
                    >{l.label} <span class="muted">({l.level})</span></span
                  >
                </li>
              {/each}
            </ul>
            <p class="tiny muted">
              {chosenRisk.about}色が無い所は「今後の情報等に留意」です。
            </p>
            <p class="tiny muted">
              出典: <a href={RISK_PAGE} target="_blank" rel="noopener"
                >{RISK_CREDIT}</a
              >
            </p>
            <p class="tiny muted" data-testid="hazard-hidden">
              色がぶつからないよう、警報・注意報の塗り{roadSpeedShown
                ? "・通れた道 (目安) の線"
                : ""}を隠しています
              (特別警報・緊急地震速報は縁取りで出します)。「なし」に戻すと元に戻ります。
            </p>
          </figure>
        {:else if boxHeight >= NOTE_MIN_HEIGHT}
          <p class="map-note tiny muted" data-testid="quake-hides-risk">
            地震を選んでいる間は、キキクル{warningsPainted
              ? "と気象警報・注意報の塗り"
              : ""}を隠しています (震度の色と重なるため){specialPainted
              ? "。特別警報は縁取りで出します"
              : ""}。一覧へ戻ると元に戻ります。
          </p>
        {/if}
      {/if}
      <!-- 地震を選んでいる間に、気象警報・注意報の塗りを隠していることと戻し方 (ハザードマップ・雨雲・キキクルの凡例が書くときは出さない) -->
      {#if chosenNowc}
        <!-- 雷・竜巻の凡例と、いつの解析か。古い解析をいまのものと取り違えないよう、時刻をいつも出す -->
        {#if nowcOn}
          <figure class="legend rain-legend" data-testid="nowc-legend">
            <figcaption class="small bold">{chosenNowc.title}</figcaption>
            {#if nowcFrame && nowcReady}
              <p class="small rain-time" data-testid="nowc-time">
                {#if nowcOld}
                  <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                  {jst(stampIso(nowcFrame.validtime))} の解析です。新しい解析を読めていないため、いまのものではありません
                {:else}
                  {jst(stampIso(nowcFrame.validtime))} の解析 (10 分ごとに更新)
                {/if}
              </p>
            {:else if nowcFailed}
              <p class="small rain-time" data-testid="nowc-time">
                <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                読み込めませんでした。1 分後に再試行します
              </p>
            {:else}
              <p class="small muted" data-testid="nowc-time">
                読み込んでいます…
              </p>
            {/if}
            <ul class="risk-scale">
              {#each chosenNowc.legend as l (l.label)}
                <li>
                  <span class="rain-swatch" style:background={l.color}
                  ></span><span class="tiny"
                    >{l.label} <span class="muted">({l.note})</span></span
                  >
                </li>
              {/each}
            </ul>
            <p class="tiny muted">{chosenNowc.about}</p>
            <p class="tiny muted">
              出典: <a href={NOWC_PAGE} target="_blank" rel="noopener"
                >{chosenNowc.credit}</a
              >
            </p>
            <p class="tiny muted" data-testid="hazard-hidden">
              色がぶつからないよう、警報・注意報の塗り{roadSpeedShown
                ? "・通れた道 (目安) の線"
                : ""}を隠しています
              (特別警報・緊急地震速報は縁取りで出します)。「なし」に戻すと元に戻ります。
            </p>
          </figure>
        {:else if boxHeight >= NOTE_MIN_HEIGHT}
          <p class="map-note tiny muted" data-testid="quake-hides-nowc">
            地震を選んでいる間は、{chosenNowc.label.replace(
              / \(.*\)$/,
              "",
            )}{warningsPainted ? "と気象警報・注意報の塗り" : ""}を隠しています
            (震度の色と重なるため){specialPainted
              ? "。特別警報は縁取りで出します"
              : ""}。一覧へ戻ると元に戻ります。
          </p>
        {/if}
      {/if}
      {#if forecastChosen}
        <!--
          今後の雨の凡例。いまの雨と取り違えないよう、何時までの予測かを大きく出し、‹ › で先の時刻へ動かす
          (自動では動かさない。docs/map.md の「今後の雨」)
        -->
        {#if nowcOn}
          <figure class="legend rain-legend" data-testid="forecast-legend">
            <figcaption class="small bold">
              今後の雨 (1 時間の雨量 mm)
            </figcaption>
            {#if forecastFrame}
              <p class="forecast-time bold" data-testid="forecast-time">
                {jst(stampIso(forecastFrame.validtime))} までの予測
              </p>
              <div class="forecast-step">
                <button
                  type="button"
                  class="ghost small step"
                  aria-label="1 つ前の予測"
                  disabled={forecastStep <= 0}
                  onclick={() => (forecastStep = Math.max(0, forecastStep - 1))}
                  data-testid="forecast-prev">‹</button
                >
                <span class="small">{hoursAhead(forecastFrame)} 時間先</span>
                <button
                  type="button"
                  class="ghost small step"
                  aria-label="1 つ先の予測"
                  disabled={forecastStep >= forecast.length - 1}
                  onclick={() =>
                    (forecastStep = Math.min(
                      forecast.length - 1,
                      forecastStep + 1,
                    ))}
                  data-testid="forecast-next">›</button
                >
              </div>
              <p class="tiny muted">
                {#if forecastOld}
                  <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                {/if}
                {jst(stampIso(forecastFrame.basetime))} の解析にもとづく気象庁の予測です{forecastOld
                  ? "。新しい予測を読めていません"
                  : ""}。いまの雨ではありません。
              </p>
            {:else if forecastFailed}
              <p class="small rain-time">
                <span class="warn-mark"><Icon icon={TriangleAlert} /></span>
                今後の雨を読み込めませんでした。1 分後に再試行します
              </p>
            {:else}
              <p class="small muted">読み込んでいます…</p>
            {/if}
            <ul class="rain-scale">
              {#each RASRF_LEGEND as l (l.label)}
                <li>
                  <span class="rain-swatch" style:background={l.color}
                  ></span><span class="tiny">{l.label}</span>
                </li>
              {/each}
            </ul>
            <p class="tiny muted">
              出典: <a href={RASRF_PAGE} target="_blank" rel="noopener"
                >気象庁 (今後の雨)</a
              >
            </p>
            <p class="tiny muted" data-testid="hazard-hidden">
              色がぶつからないよう、警報・注意報の塗り{roadSpeedShown
                ? "・通れた道 (目安) の線"
                : ""}を隠しています
              (特別警報・緊急地震速報は縁取りで出します)。「なし」に戻すと元に戻ります。
            </p>
          </figure>
        {:else if boxHeight >= NOTE_MIN_HEIGHT}
          <p class="map-note tiny muted" data-testid="quake-hides-forecast">
            地震を選んでいる間は、今後の雨{warningsPainted
              ? "と気象警報・注意報の塗り"
              : ""}を隠しています (震度の色と重なるため){specialPainted
              ? "。特別警報は縁取りで出します"
              : ""}。一覧へ戻ると元に戻ります。
          </p>
        {/if}
      {/if}
      {#if slmcsAt && boxHeight >= NOTE_MIN_HEIGHT}
        <!-- 線状降水帯の雨域を描いている間だけ、赤い線が何かを書く (いつも描く層なので、凡例の代わり) -->
        <p class="map-note tiny" data-testid="slmcs-note">
          <span class="slmcs-mark"></span>赤い線: 線状降水帯の雨域 ({jst(
            slmcsAt,
          )} の解析・気象庁)
        </p>
      {/if}
      {#if quakeShown && warningsPainted && !covered && hazard !== "rain" && !chosenRisk && !nowcOn && !chosenNowc && !forecastChosen && boxHeight >= NOTE_MIN_HEIGHT}
        <p class="map-note tiny muted" data-testid="quake-hides-warnings">
          地震を選んでいる間は、気象警報・注意報の塗りを隠しています{specialPainted
            ? " (特別警報は縁取りで出します)"
            : ""}。一覧へ戻ると元に戻ります。
        </p>
      {/if}
      {#if locateNote}
        <p class="locate-note small" role="status">{locateNote}</p>
      {/if}
    </div>
    <a
      class="map-credit"
      href={aboutHref}
      bind:this={creditEl}
      data-testid="map-credit">{creditText}</a
    >
    <!--
      地図のメニュー (右クリック・長押し)。押した所に目に見えない引き金を置き、ほかのメニューと同じ Menu で開く
      (外を押すと閉じる・Esc で閉じる・↑↓で動く)
    -->
    <div
      class="place-anchor"
      style:left="{place?.x ?? 0}px"
      style:top="{place?.y ?? 0}px"
    >
      <Menu
        bind:open={placeMenu}
        align="start"
        testid="place-menu"
        onclosed={placeClosed}
      >
        {#snippet trigger(props)}
          <button
            {...props}
            type="button"
            class="place-trigger"
            tabindex="-1"
            aria-label="この場所のメニュー"
          ></button>
        {/snippet}
        {#if place}
          <p class="menu-head">{coordLabel(place.lat, place.lon)}</p>
        {/if}
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          onclick={() => void setHomeHere()}
          data-testid="place-home">ここを住んでいる地域にする</button
        >
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          onclick={() => void copyCoords()}
          data-testid="place-copy">緯度・経度を写す</button
        >
      </Menu>
    </div>
    {#if placeNote}
      <p class="place-note small" role="status" data-testid="place-note">
        {placeNote}
      </p>
    {/if}
  </div>
{/if}

<style>
  .map-box {
    /* 隅の出典 (1 行) の高さ。広い形は下の角、スマホの形は上の角に置くので、そちらの端を空ける */
    --credit-bottom: 0.9375rem;
    --credit-top: 0px;
    position: relative;
    width: 100%;
    height: 100%;
  }
  :global(html[data-phone]) .map-box {
    --credit-bottom: 0px;
    --credit-top: 0.9375rem;
  }
  /*
   * 地図の上の操作 (ハザードマップの選択と現在地のボタン) は右下にまとめる。広い形は隅の出典 (1 行) のすぐ上、
   * スマホの形は下のタブと dock のすぐ上 (`--map-bottom`。出典は上の角)。並びは下から操作の 1 行・凡例・知らせ
   */
  .controls {
    position: absolute;
    right: var(--so-space-3);
    bottom: calc(
      var(--map-bottom, 0px) + var(--so-space-2) + var(--credit-bottom)
    );
    z-index: 1;
    display: flex;
    flex-direction: column-reverse;
    align-items: flex-end;
    gap: var(--so-space-2);
    max-width: min(18rem, calc(100% - 2 * var(--so-space-3)));
    /* 上の帯 (音が止まっているとき)・上の余白・スマホの形の上の角の出典にかからない高さまで */
    max-height: calc(
      100% - var(--map-top, 0px) - var(--map-bottom, 0px) - var(--credit-top) -
        var(--credit-bottom) - 3 * var(--so-space-3)
    );
    pointer-events: none;
  }
  .control-row {
    display: flex;
    align-items: center;
    gap: var(--so-space-2);
  }
  /*
   * 現在地のボタン。地図 (動く中身) の上に重なるので操作の層 (面と影) に乗せる。
   * オンは並びの外の切り替えなので、主の色のアイコンと短い下線 (denpa の 6 章「ボタン」)
   */
  .locate-button {
    position: relative;
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--so-radius-full);
    background: var(--so-float);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
    pointer-events: auto;
    transition: scale var(--so-duration) var(--so-ease);
  }
  .locate-button:active {
    scale: 0.97;
  }
  .locate-button:is([aria-pressed="true"], [aria-pressed="mixed"]) {
    color: var(--so-primary-text);
  }
  .locate-button:is([aria-pressed="true"], [aria-pressed="mixed"])::after {
    content: "";
    position: absolute;
    bottom: 0.45rem;
    left: 50%;
    width: 0.75rem;
    height: var(--so-mark);
    border-radius: var(--so-mark);
    background: var(--pico-primary);
    translate: -50% 0;
  }
  /*
   * 探している間と、オンを覚えていて許可を待っている間 (押すと始める) はアイコンを薄くする
   * (時間で動き続けるものは足さない。docs/design.md の 6.3)。どちらも下線は残る (オン)
   */
  .locate-button:is([data-locating="waiting"], [data-locating="paused"])
    :global(svg) {
    opacity: 0.45;
  }
  /* ハザードマップの選択 (右下の 1 行の左)。選択肢は上へ開く */
  .hazard {
    display: flex;
    min-width: 0;
  }
  /* メニューは最前面に出るが、DOM ではこの箱の子なので、押せるように戻す */
  .hazard :global(.menu) {
    pointer-events: auto;
  }
  .map-pill {
    min-height: 2.75rem;
    margin: 0;
    padding: 0 var(--so-space-4);
    border: 0;
    border-radius: var(--so-radius-full);
    background: var(--so-float);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
    font-size: var(--so-text-sm);
    font-weight: var(--so-weight-bold);
    white-space: nowrap;
    pointer-events: auto;
  }
  .legend {
    display: flex;
    flex-direction: column;
    gap: var(--so-space-1);
    margin: 0;
    padding: var(--so-space-2) var(--so-space-3);
    border-radius: var(--so-item-radius);
    background: var(--so-pop);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
    pointer-events: auto;
    /* 土砂災害は凡例が 3 枚あるので、画面の高さの 55% を超えたら中で巻く */
    max-height: 55dvh;
    overflow-y: auto;
  }
  .legend figcaption,
  .legend p {
    margin: 0;
  }
  /* 今後の雨の時刻。何時までの予測かを大きく出し、左右に ‹ › */
  .forecast-step {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--so-space-1);
  }
  .forecast-step .step {
    min-width: 2.75rem;
    min-height: 2.75rem;
    margin: 0;
    padding: 0;
    font-size: var(--so-text-lg);
  }
  .forecast-time {
    font-size: var(--so-text-lg);
    text-align: center;
  }
  /* 線状降水帯の雨域の線の見本 (地図の線と同じ白い縁の赤) */
  .slmcs-mark {
    display: inline-block;
    width: 1rem;
    height: 0.25rem;
    margin-inline-end: var(--so-space-1);
    vertical-align: middle;
    border: 1px solid #fff;
    background: rgb(255 0 0);
  }
  /* 洪水の図の切り替え。凡例の幅に収まるよう詰め、入りきらなければ折り返す */
  .legend .variants {
    gap: 0;
    margin-inline: calc(-1 * var(--so-space-2));
  }
  .legend .variants .chip {
    padding: 0 var(--so-space-2);
  }
  /* 公式の凡例は白い地の画像なので、暗いテーマでも白い台に載せる */
  .legend img {
    display: block;
    max-width: 100%;
    /* 小さな凡例 (家屋倒壊等の 100px の模様) を引き伸ばさない */
    width: auto;
    align-self: flex-start;
    height: auto;
    padding: var(--so-space-1);
    border-radius: var(--so-radius-sm);
    background: #fff;
  }
  /* 雨雲の凡例。8 色を 2 列に並べ、色の見本の右に mm/h の区切り (強いものから) */
  .rain-scale {
    display: grid;
    grid-template-columns: repeat(2, auto);
    grid-auto-flow: column;
    grid-template-rows: repeat(4, auto);
    justify-content: start;
    gap: 0.125rem var(--so-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* キキクルの凡例。4 段を 1 列に、危険度の高いものから (気象庁の凡例と同じ並び) */
  .risk-scale {
    display: grid;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rain-scale li,
  .risk-scale li {
    display: flex;
    align-items: center;
    gap: var(--so-space-1);
    margin: 0;
    list-style: none;
  }
  /* 0〜1 の淡い色も面の上で見えるよう、細い縁を付ける */
  .rain-swatch {
    width: 1rem;
    height: 0.75rem;
    border: 1px solid rgb(0 0 0 / 0.35);
    border-radius: 2px;
  }
  /* 古い雨雲・読めないときの印。字は本文の色のまま、アイコンだけ注意の色 (denpa の 6 章「通知」) */
  .rain-time .warn-mark {
    display: inline-flex;
    vertical-align: -0.125em;
    color: var(--so-warn-text);
  }
  /* 避難場所と気象警報・注意報の吹き出し (MapLibre が DOM に置くので :global)。メニューと同じ面 */
  .map :global(.maplibregl-popup-content) {
    padding: var(--so-space-2) var(--so-space-3);
    border-radius: var(--so-item-radius);
    background: var(--so-pop);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
  }
  .map :global(.maplibregl-popup-tip) {
    display: none;
  }
  .map :global(.shelter-pop p),
  .map :global(.warning-pop p),
  .map :global(.station-pop p) {
    margin: 0 0 var(--so-space-1);
  }
  .map :global(.warning-pop p:last-child),
  .map :global(.station-pop p:last-child) {
    margin-bottom: 0;
  }
  /* 震度 1 の白い地も面の上で見えるよう、地図の震度のラベルと同じ細い縁を付ける */
  .map :global(.station-pop .level-label) {
    display: inline-block;
    border: 1px solid rgb(0 0 0 / 0.35);
  }
  /* 気象警報・注意報の吹き出しの種類の並び。ラベルは WarningLevel.svelte と同じ形 */
  .map :global(.warning-kinds) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--so-space-1);
    margin: 0 0 var(--so-space-2);
    padding: 0;
    list-style: none;
  }
  .map :global(.warning-kinds li) {
    margin: 0;
    list-style: none;
  }
  @media (max-width: 639.98px) {
    /* 狭い画面では凡例を細くする (地図を隠しすぎない) */
    .legend {
      max-width: 12rem;
    }
  }
  /* 地図のメニューの引き金。押した所に置く大きさの無い点 (メニューはここから右下へ出る) */
  .place-anchor {
    position: absolute;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  /* メニューは最前面に出るが、DOM ではこの点の子なので、押せるように戻す */
  .place-anchor :global(.menu) {
    pointer-events: auto;
  }
  .place-trigger {
    display: block;
    width: 0;
    height: 0;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
  }
  /*
   * メニューの操作の結果の知らせ。地図の上の真ん中に、操作の層と同じ面で
   * (下は右下の操作・出典とスマホの形の下のタブと dock があるので、空いている上に出す)
   */
  .place-note {
    position: absolute;
    left: 50%;
    top: calc(var(--map-top, 0px) + var(--credit-top) + var(--so-space-3));
    z-index: 1;
    max-width: min(24rem, calc(100% - 2 * var(--so-space-3)));
    margin: 0;
    padding: var(--so-space-2) var(--so-space-3);
    border-radius: var(--so-item-radius);
    background: var(--so-pop);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
    translate: -50% 0;
  }
  /* 地震を選んでいる間に警報・注意報を隠していることの一言。凡例と同じ面で、地図を隠しすぎないよう細く */
  .map-note {
    max-width: 16rem;
    margin: 0;
    padding: var(--so-space-1) var(--so-space-2);
    border-radius: var(--so-item-radius);
    background: var(--so-pop);
    box-shadow: var(--so-shadow-pop);
  }
  @media (max-width: 639.98px) {
    .map-note {
      max-width: 12rem;
    }
  }
  .locate-note {
    margin: 0;
    padding: var(--so-space-2) var(--so-space-3);
    border-radius: var(--so-item-radius);
    background: var(--so-pop);
    box-shadow: var(--so-shadow-pop);
    color: var(--so-fg);
    pointer-events: auto;
  }
  .map {
    width: 100%;
    height: 100%;
    border-radius: var(--map-radius, 0);
    overflow: hidden;
    background: #0b1a2e;
  }
  .map-failed {
    height: 100%;
    justify-content: center;
  }
  /*
   * 地図の隅の短い出典 (いつも見える。国土地理院の出典の記載の決まり)。押すと「出典と注意」の窓。
   * 地図の隅にぴったり付けた、余白の無い薄い帯にする (よくある地図の出典の形)。地図を覆わないよう小さく薄く、
   * 写真の上でも読めるよう地の色を 65% の濃さで敷く。
   * スマホの形は地図の上の角 (右上)。下は浮いた下のタブ・dock・操作が重なり、ぴったり付ける角が無いため。
   * 音が止まっているときの上の帯は地図を押し下げるので、帯にも隠れない
   */
  .map-credit {
    position: absolute;
    right: 0;
    bottom: var(--map-bottom, 0px);
    z-index: 1;
    max-width: 100%;
    padding: 0 0.3rem;
    /* 地図の角の丸みに合わせる */
    border-bottom-right-radius: var(--map-radius, 0);
    background: color-mix(in srgb, var(--so-bg) 65%, transparent);
    color: var(--so-muted);
    font-size: 0.625rem;
    line-height: 1.5;
    text-align: right;
    text-decoration: none;
  }
  /* 字は小さいので、押せる所だけ指の大きさまで広げる (見た目は変えない) */
  .map-credit::after {
    content: "";
    position: absolute;
    inset: -0.75rem 0 0;
  }
  :global(html[data-phone]) .map-credit {
    top: var(--map-top, 0px);
    bottom: auto;
    border-radius: 0;
  }
  :global(html[data-phone]) .map-credit::after {
    inset: 0 0 -0.75rem;
  }
  .map-credit:hover {
    text-decoration: underline;
  }
  /* 地図の上のラベル (MapLibre が DOM に置くので :global) */
  .map :global(.int-label) {
    display: inline-block;
    min-width: 1.9em;
    border: 1px solid rgb(0 0 0 / 0.35);
    border-radius: var(--so-radius-sm);
    padding: 0 0.25em;
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight-bold);
    line-height: 1.6;
    text-align: center;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
  /* 検索の欄で選んだ場所の印。白い縁の橙の丸 (現在地の青い点・震央の × と色と形で見分ける) */
  .map :global(.found-mark) {
    width: 1.1rem;
    height: 1.1rem;
    border: 3px solid #fff;
    border-radius: 50%;
    background: #e8590c;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.6);
  }
  /* 震央の × */
  .map :global(.epicenter) {
    display: block;
    width: 1.6rem;
    height: 1.6rem;
    background:
      linear-gradient(45deg, transparent 42%, #ff2800 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, #ff2800 42% 58%, transparent 58%);
    filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff);
  }
  /* 火山の印。三角を警戒の段の色で塗り、段の数字を字でも出す (色だけに頼らない)。影は三角で切られないよう外の要素に */
  /*
   * 位置は MapLibre の印 (`.maplibregl-marker` の position: absolute) のまま。relative で上書きすると、
   * 印が地図の幅いっぱいの箱になり、anchor の -50% で三角が左へずれる (2026-11-21 に直した)。
   * 字 (.volcano-caption) は absolute の印を基準に置かれる
   */
  .map :global(.volcano-wrap) {
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.7));
  }
  /*
   * 段の分からない火山の字 (噴火速報・種類の名前)。三角の右に、一覧のラベル (VolcanoLevel) と同じ灰色の地で置く。
   * 外に出して置くので、印の位置 (三角の下の端) は動かない
   */
  .map :global(.volcano-caption) {
    position: absolute;
    bottom: 0;
    left: calc(100% + 0.125rem);
    padding: 0 0.25rem;
    border-radius: 0.25rem;
    background: rgb(200 200 203);
    color: #000;
    font-size: var(--so-text-2xs);
    font-weight: var(--so-weight-bold);
    line-height: 1.4;
    white-space: nowrap;
  }
  .map :global(.volcano-mark) {
    display: grid;
    place-items: end center;
    width: 1.5rem;
    height: 1.3rem;
    padding-bottom: 0.05rem;
    background: var(--volcano-bg, rgb(200 200 203));
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
    font-size: var(--so-text-2xs);
    font-weight: var(--so-weight-bold);
    line-height: 1;
  }
  .map :global(.volcano-mark.selected) {
    width: 2rem;
    height: 1.75rem;
    font-size: var(--so-text-xs);
  }
  /* 緊急地震速報の震央は、出たときに 3 回だけ大きさで脈打つ (transform だけ) */
  .map :global(.epicenter.eew) {
    --so-pulse-scale: 1.35;
    animation: var(--so-pulse);
  }
</style>
