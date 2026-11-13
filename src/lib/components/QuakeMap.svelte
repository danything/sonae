<script lang="ts">
  import "maplibre-gl/dist/maplibre-gl.css";
  import type { Map as MapLibreMap, Marker } from "maplibre-gl";
  // MapLibre の描き手の worker。既定では本体の隣の maplibre-gl-worker.mjs を探すが、束ねると
  // 見つからないので、Vite に別に束ねさせて URL を渡す
  import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
  import { untrack } from "svelte";

  import { INTENSITY_COLORS } from "#lib/format.ts";
  import {
    baseStyle,
    eewFill,
    hypocenterFeatures,
    intensityFill,
    intensityLabels,
    JAPAN_BOUNDS,
    type LayerState,
    longPeriodLine,
    mapVisibility,
    tsunamiPaint,
  } from "#lib/map/style.ts";
  import {
    type Eew,
    intensityLabel,
    type LongPeriod,
    type Quake,
    type Tsunami,
  } from "#lib/model.ts";

  /**
   * 地図 (docs/map.md)。下地は国土地理院のシームレス空中写真。その上に層を重ね、層ごとに出し入れする。
   * カメラは飛ばさない (jumpTo)。MapLibre は止まっている間は描かないので、開いているだけで CPU は使わない。
   */
  let {
    quake,
    longPeriod,
    quakes,
    tsunamis,
    eews,
    layers,
    shown = true,
  }: {
    quake: Quake | undefined;
    /** 地図に出している地震の長周期地震動 (無ければ枠を描かない) */
    longPeriod?: LongPeriod | null;
    quakes: Quake[];
    tsunamis: Tsunami[];
    eews: Eew[];
    layers: LayerState;
    /** 地図が見えているか (スマホの形で一覧の面が上にある間は false) */
    shown?: boolean;
  } = $props();

  let container = $state<HTMLDivElement>();
  let map = $state<MapLibreMap | undefined>();
  /** 地図を出せない理由 (出せるときは空) */
  let failed = $state("");
  let MarkerClass: typeof Marker | undefined;
  let points: Record<string, [number, number]> = {};
  /** 名前 → 細分区域のコード (P2P は名前だけで来る) */
  const codeByName = new Map<string, string>();
  let markers: Marker[] = [];

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
      const [{ Map: MapClass, Marker: M, setWorkerUrl }, pts, areas] =
        await Promise.all([
          import("maplibre-gl"),
          fetch("/areas/quake-points.json").then((r) => r.json()),
          fetch("/areas/quake-areas.geojson").then((r) => r.json()),
        ]);
      if (disposed || !container) return;
      setWorkerUrl(workerUrl);
      MarkerClass = M;
      points = pts as Record<string, [number, number]>;
      for (const f of (
        areas as { features: { properties: { code: string; name: string } }[] }
      ).features)
        codeByName.set(f.properties.name, f.properties.code);
      created = new MapClass({
        container,
        style: baseStyle(untrack(() => layers)) as never,
        bounds: JAPAN_BOUNDS,
        attributionControl: { compact: true },
        // 回すと読みにくいだけなので、北を上に固定する
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
      created.touchZoomRotate.disableRotation();
      created.on("load", () => {
        if (!disposed) map = created;
        // 出典は (i) に畳んでおく (開くと地図の下を覆う)。同じ出典は画面の下の注意文の下にもいつも出している
        container
          ?.querySelector(".maplibregl-ctrl-attrib")
          ?.classList.remove("maplibregl-compact-show");
      });
    })().catch((err: unknown) => {
      console.warn(`地図を開けませんでした: ${err}`);
      failed =
        "地図を読み込めませんでした。つながりを確かめて、読み込み直してください。";
    });
    return () => {
      disposed = true;
      paintedSig = "";
      markedSig = "";
      for (const m of markers) m.remove();
      markers = [];
      created?.remove();
      map = undefined;
    };
  });

  // 層の出し入れ
  $effect(() => {
    if (!map) return;
    for (const [layer, on] of Object.entries(mapVisibility(layers)))
      map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
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
  });

  // 震度のラベル・震央の印 (字を描くのに地図用の字体を落とさないよう、DOM の印で置く)
  $effect(() => {
    if (!map || !MarkerClass) return;
    const next = sig(
      quake?.id,
      quake?.updatedAt,
      eewSig(eews),
      layers.intensity,
      layers.hypocenters,
      layers.eew,
    );
    if (next === markedSig) return;
    markedSig = next;
    for (const m of markers) m.remove();
    markers = [];
    if (layers.intensity && quake) {
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
      layers.hypocenters &&
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
    if (layers.eew) {
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
    }
  });

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

  // 選んだ地震 (と、出ている緊急地震速報) の震央へ寄せる。飛ばさない。
  // 続報で中身が変わるたびに寄せ直すと、見ている所が勝手に動くので、寄せるのは選んだものが替わったときと、
  // 地図が見えたとき (スマホの形で地図のタブに移ったとき) に震央が画面の外にあるときだけ
  let focused = "";
  let wasShown = false;
  $effect(() => {
    if (!map) return;
    const eew = eews.find((e) => !e.cancelled);
    const key = eew ? `eew:${eew.eventId}` : `quake:${quake?.id ?? ""}`;
    const h = eew?.hypocenter ?? quake?.hypocenter;
    const appeared = shown && !wasShown;
    wasShown = shown;
    if (h?.lat === undefined || h.lon === undefined) return;
    const center: [number, number] = [h.lon, h.lat];
    const away = appeared && !map.getBounds().contains(center);
    if (key === focused && !away) return;
    focused = key;
    map.jumpTo({ center, zoom: Math.max(map.getZoom(), 5.5) });
  });
</script>

{#if failed}
  <div class="map-failed empty-state"><p class="muted">{failed}</p></div>
{:else}
  <div class="map" bind:this={container} role="region" aria-label="地図"></div>
{/if}

<style>
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
  /* 地図の右下の出典。スマホの形では下のタブと dock の上に出す (`--map-bottom` は置く側が決める) */
  .map :global(.maplibregl-ctrl-bottom-right) {
    bottom: var(--map-bottom, 0px);
  }
  /*
   * 出典の (i) は MapLibre の <details> と <summary>。詳しい内容の折り畳み (Blades の accordion) の
   * `details summary::after` (開閉の矢印) が (i) に重なるので、ここでは外す
   */
  .map :global(.maplibregl-ctrl-attrib-button::after) {
    content: none;
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
