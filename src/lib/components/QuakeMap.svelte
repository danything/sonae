<script lang="ts">
  import "maplibre-gl/dist/maplibre-gl.css";
  import type { LngLat, Map as MapLibreMap, Marker, Popup } from "maplibre-gl";
  // MapLibre の描き手の worker。既定では本体の隣の maplibre-gl-worker.mjs を探すが、束ねると
  // 見つからないので、Vite に別に束ねさせて URL を渡す
  import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
  import { untrack } from "svelte";
  import Locate from "~icons/lucide/locate";
  import LocateFixed from "~icons/lucide/locate-fixed";

  import { alerter } from "#lib/alerter.svelte.ts";
  import Icon from "#lib/components/Icon.svelte";
  import Menu from "#lib/components/Menu.svelte";
  import {
    INTENSITY_COLORS,
    jstFull,
    kindText,
    VOLCANO_COLORS,
    volcanoKindText,
    WARNING_COLORS,
  } from "#lib/format.ts";
  import { edgePadding } from "#lib/map/edges.ts";
  import {
    autoLocate,
    type GeoPermission,
    LOCATE_PREF,
    readLocate,
  } from "#lib/map/locate.ts";
  import { coordLabel, coordText, longPressOk } from "#lib/map/press.ts";
  import {
    baseStyle,
    eewFill,
    foreignFeatures,
    hazardCovers,
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
    officeBounds,
    officeFilter,
    type OfficeTable,
    overlayVisibility,
    readHazard,
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
    cityLevels,
    cityWarnings,
    type Eew,
    type ForeignQuake,
    intensityLabel,
    type LongPeriod,
    type Quake,
    type Tsunami,
    type Volcano,
    type WeatherWarning,
  } from "#lib/model.ts";
  import { mapCredit, showsGrus } from "#lib/notice.ts";
  import type { Place } from "#lib/places.ts";
  import { readPref, writePref } from "#lib/prefs.ts";
  import { homeAt, saveHome, trackHere } from "#lib/push-client.ts";

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
    warnings = [],
    office = null,
    officeHref,
    onoffice,
    aboutHref = "/?about=1",
    shown = true,
    found = null,
  }: {
    /** いまの気象警報・注意報 (市町村等を段の色で塗る。押すと吹き出し) */
    warnings?: WeatherWarning[];
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
    /** 地図が見えているか (スマホの形で一覧の面が上にある間は false) */
    shown?: boolean;
    /** 検索の欄で選んだ場所 (寄せて印を置く。`n` が替わるたびに寄せる) */
    found?: { place: Place; n: number } | null;
    /** 隅の出典を押したときに開く「出典と注意」の窓のリンク */
    aboutHref?: string;
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
        created.addImage("shelter", shelterIcon(), { pixelRatio: 2 });
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
        created.on("mouseenter", "shelters", () => {
          if (created) created.getCanvas().style.cursor = "pointer";
        });
        created.on("mouseleave", "shelters", () => {
          if (created) created.getCanvas().style.cursor = "";
        });
        // 塗った市町村等を押すと、出ている警報・注意報の吹き出し。上の層 (避難場所の印) を押したときはそちらだけ
        created.on("click", "warning-fill", (e) => {
          if (
            !created ||
            placeMenu ||
            created.queryRenderedFeatures(e.point, { layers: ["shelters"] })
              .length > 0
          )
            return;
          const code = e.features?.[0]?.properties?.code;
          if (typeof code === "string") openWarning(code, e.lngLat);
        });
        // 面は塗っていない所にもあるので、塗った所の上でだけ指の形にする
        created.on("mousemove", "warning-fill", (e) => {
          if (!created) return;
          const code = e.features?.[0]?.properties?.code;
          const over =
            created.queryRenderedFeatures(e.point, { layers: ["shelters"] })
              .length > 0;
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
        created.on("movestart", () => {
          pressMoved = true;
          placeMenu = false;
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
  const eewSig = (es: Eew[]) =>
    es.map((e) => [e.eventId, e.serial, e.cancelled, e.warnAreas.length]);
  let paintedSig = "";
  let markedSig = "";

  // 気象警報・注意報の色 (報が替わったときだけ塗り直す)
  let warningSig = "";
  /** 塗っている市町村等 (指の形にするか決める) */
  let paintedCities: ReadonlyMap<string, unknown> = new Map();
  $effect(() => {
    if (!map) return;
    const next = sig(warnings.map((w) => [w.id, w.reportedAt]));
    if (next === warningSig) return;
    warningSig = next;
    const levels = cityLevels(warnings);
    paintedCities = levels;
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
      .catch(() => {
        // 次に選んだときに読み直す
        officesLoading = false;
      });
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
    const src = map.getSource("hypocenters");
    if (src && "setData" in src)
      (src as { setData(d: unknown): void }).setData(
        hypocenterFeatures(quakes),
      );
    const fsrc = map.getSource("foreign");
    if (fsrc && "setData" in fsrc)
      (fsrc as { setData(d: unknown): void }).setData(foreignFeatures(foreign));
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
  /** 位置を取れないわけ (無ければ空)。ボタンの下に出す */
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
        // 許可されなかったときは追うのをやめ、覚えたオンも消す。一時的に取れないだけなら追い続ける
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
  // 端末は初めの 1 度だけ許可を聞く。人がオンにした端末で許可が消えていたら、押すのを待つ。
  // 許可が変わったら (サイトの設定で変えたとき) 合わせる。拒まれたらオフを覚える (聞き直さない)
  $effect(() => {
    const choice = readLocate(readPref(LOCATE_PREF));
    remembered = choice !== "off";
    let status: PermissionStatus | undefined;
    let gone = false;
    const apply = (p: GeoPermission) => {
      const next = autoLocate(
        remembered ? readLocate(readPref(LOCATE_PREF)) : "off",
        p,
      );
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
        // query が無い・geolocation を聞けないブラウザでは始めない (押せば始まる)
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
    const src = map.getSource("me");
    if (src && "setData" in src)
      (src as { setData(d: unknown): void }).setData(
        me
          ? meFeatures(me.lon, me.lat, me.accuracy)
          : { type: "FeatureCollection", features: [] },
      );
    if (me && !panned) {
      panned = true;
      locateNote = "";
      map.jumpTo({
        center: [me.lon, me.lat],
        zoom: Math.max(map.getZoom(), 13),
      });
    }
  });

  // ---- ハザードマップ (なし・洪水・土砂災害・津波・活断層から 1 つ。色がぶつかるので重ねない。端末に覚える) ----
  // 選んでいる間は、面で塗る警報・注意報や震度の色を隠す (`overlayVisibility`。特別警報は縁取りで残す)
  let hazard = $state<HazardId>("none");
  let hazardMenu = $state(false);
  $effect.pre(() => {
    hazard = readHazard(readPref("map.hazard"));
  });
  const chosenHazard = $derived(HAZARDS.find((h) => h.id === hazard));
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
  $effect(() => {
    if (!map) return;
    for (const [layer, on] of Object.entries({
      ...hazardVisibility(hazard),
      ...overlayVisibility(hazard, zoom),
    }))
      map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    // 塗りを隠している間は、塗った所の吹き出しも出さない
    if (covered) warningPopup?.remove();
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
  /** メニューの操作の結果の知らせ (地図の下に少しの間だけ出す) */
  let placeNote = $state("");
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  function openPlace(x: number, y: number, lat: number, lon: number): void {
    place = { x, y, lat, lon };
    // 開いている吹き出しは閉じる (重なって読みにくい)
    shelterPopup?.remove();
    warningPopup?.remove();
    placeMenu = true;
  }

  function showNote(text: string): void {
    placeNote = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (placeNote = ""), 8000);
  }

  /** 押した所が入る市町村等を、住んでいる地域にする (通知の窓の「現在地から選ぶ」と同じ探し方と覚え方) */
  /** 住んでいる地域を探して覚えている途中か (続けて押したときに、知らせの文が前後しないよう 1 つずつ) */
  let homeBusy = false;
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
      showNote(`住んでいる地域を決められませんでした: ${err}`);
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
    el.addEventListener("touchstart", onstart, { passive: true });
    el.addEventListener("contextmenu", oncontext);
    return () => {
      clearTimeout(noteTimer);
      el.removeEventListener("touchstart", onstart);
      el.removeEventListener("contextmenu", oncontext);
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
    const src = map?.getSource("shelters");
    if (src && "setData" in src)
      (src as { setData(d: unknown): void }).setData({
        type: "FeatureCollection",
        features: mergeShelters(parts),
      });
  }

  /** 避難場所の印 (緑の角丸の四角に白い「避」)。端末の字体で 1 度だけ描く */
  function shelterIcon(): ImageData {
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
    g.fillStyle = "#ffffff";
    g.font = `bold 24px ${TEXT_FONT_CSS}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("避", s / 2, s / 2 + 1);
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
    padding?: { top: number; bottom: number; left: number; right: number };
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
    line(
      "国土地理院のデータで、最新でないことがあります。避難先は市町村の情報で確かめてください。",
      "tiny muted",
    );
    shelterPopup?.remove();
    warningPopup?.remove();
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
    // ハザードマップを重ねている間は塗りを隠しているので、吹き出しも出さない
    if (!map || !PopupClass || covered) return;
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
      label.className = "warning-label";
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
    shelterPopup?.remove();
    warningPopup?.remove();
    warningPopup = new PopupClass(popupOptions())
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(map);
  }

  /**
   * 震央の × 。MapLibre は印の要素そのものの transform で場所を決めるので、動かすのは中の要素
   */
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
  function focusPadding(): {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } {
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
    foundJumpedAt = Date.now();
    foundMarker?.remove();
    const el = document.createElement("div");
    el.className = "found-mark";
    el.title = p.label;
    el.setAttribute("aria-label", `探した場所 ${p.label}`);
    el.setAttribute("role", "img");
    foundMarker = new MarkerClass({ element: el }).setLngLat(p.at).addTo(map);
  });

  // 選んだ地震 (と、出ている緊急地震速報) の震央へ寄せる。飛ばさない。
  // 続報で中身が変わるたびに寄せ直すと、見ている所が勝手に動くので、寄せるのは選んだものが替わったときと、
  // 地図が見えたとき (スマホの形で地図のタブに移ったとき) に震央が画面の外にあるときだけ
  let focused = "";
  /** 検索の欄で選んだ場所へ寄せた直後か (地図のタブへ移ったときに、震央へ寄せ直さない) */
  let foundJumpedAt = 0;
  let wasShown = false;
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
    const key = eew
      ? `eew:${eew.eventId}`
      : vm
        ? `volcano:${volcano?.id}`
        : fq
          ? `foreign:${fq.id}`
          : office
            ? `office:${office}`
            : `quake:${quake?.id ?? ""}`;
    const appeared = shown && !wasShown;
    wasShown = shown;
    // 検索の欄で場所を選んで地図のタブへ移ったときは、そちらを見せる (震央へ戻さない)
    if (appeared && Date.now() - foundJumpedAt < 2000) {
      foundJumpedAt = 0;
      return;
    }
    if (office && !eew && !vm && !fq) {
      if (!ob) return;
      const away =
        appeared &&
        !map
          .getBounds()
          .contains([(ob[0][0] + ob[1][0]) / 2, (ob[0][1] + ob[1][1]) / 2]);
      if (key === focused && !away) return;
      const cam = map.cameraForBounds(ob, { padding: focusPadding() });
      if (!cam) return;
      focused = key;
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
    const away = appeared && !map.getBounds().contains(center);
    if (key === focused && !away) return;
    focused = key;
    map.jumpTo({ center, zoom: fq ? 4 : Math.max(map.getZoom(), 5.5) });
  });
</script>

{#if failed}
  <div class="map-failed empty-state"><p class="muted">{failed}</p></div>
{:else}
  <div class="map-box">
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
            class="hazard-menu"
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
                ハザードマップ: {chosenHazard?.label ?? "なし"}
              </button>
            {/snippet}
            <p class="menu-head">ハザードマップ</p>
            {#each [{ id: "none" as const, label: "なし" }, ...HAZARDS] as h (h.id)}
              <button
                type="button"
                role="menuitemradio"
                class="menu-item"
                aria-checked={hazard === h.id}
                onclick={() => pickHazard(h.id)}
                data-testid="hazard-{h.id}">{h.label}</button
              >
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
        <!-- 公式の凡例 (ハザードマップポータルサイトの画像)。活断層は凡例の代わりに国土地理院の説明へのリンク -->
        <figure class="legend" data-testid="hazard-legend">
          <figcaption class="small bold">{chosenHazard.title}</figcaption>
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
          {#if chosenHazard.legends.length > 0}
            <p class="tiny muted">
              出典: <a
                href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html"
                target="_blank"
                rel="noopener">ハザードマップポータルサイト</a
              >。想定の無い川や地域は塗られていません。色が無くても安全とは限りません。
            </p>
          {/if}
          <!-- 隠している層があることと、戻し方。図が重ならないズーム (活断層の 11 未満) では隠さない -->
          {#if covered}
            <p class="tiny muted" data-testid="hazard-hidden">
              色がぶつからないよう、警報・注意報と震度の塗りを隠しています
              (特別警報・緊急地震速報は縁取りで出します)。「なし」に戻すと元に戻ります。
            </p>
          {:else}
            <p class="tiny muted" data-testid="hazard-hidden">
              寄せて図が重なると、色がぶつからないよう、警報・注意報と震度の塗りを隠します。
            </p>
          {/if}
        </figure>
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
        class="place-menu"
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
   * 現在地のボタン。地図 (動く中身) の上に重なるので操作の層 (面と影) に乗せる。
   * オンは並びの外の切り替えなので、主の色のアイコンと短い下線 (denpa の 6 章「ボタン」)
   */
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
    /* 土砂災害は凡例が 3 枚あるので、地図の高さを超えたら中で巻く */
    max-height: calc(var(--map-h, 100dvh) * 0.55);
    overflow-y: auto;
  }
  .legend figcaption,
  .legend p {
    margin: 0;
  }
  /* 公式の凡例は白い地の画像なので、暗いテーマでも白い台に載せる */
  .legend img {
    display: block;
    max-width: 100%;
    height: auto;
    padding: var(--so-space-1);
    border-radius: var(--so-radius-sm);
    background: #fff;
  }
  /* 避難場所の吹き出し (MapLibre が DOM に置くので :global)。メニューと同じ面 */
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
  .map :global(.warning-pop p) {
    margin: 0 0 var(--so-space-1);
  }
  .map :global(.warning-pop p:last-child) {
    margin-bottom: 0;
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
  .map :global(.warning-label) {
    border-radius: var(--so-radius-sm);
    padding: 0 var(--so-space-2);
    font-size: var(--so-text-xs);
    font-weight: var(--so-weight-bold);
    line-height: 1.75;
    white-space: nowrap;
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
   * 上の帯 (緊急地震速報・音が止まっている) は地図を押し下げるので、帯にも隠れない
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
  .map :global(.volcano-wrap) {
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.7));
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
    animation: eew-pulse 0.9s ease-in-out 3;
  }
  @keyframes -global-eew-pulse {
    50% {
      transform: scale(1.35);
    }
  }
</style>
