import { expect, test } from "bun:test";

import { cameraPageRelay, latestFrame } from "#lib/map/cameras.ts";
import {
  NOWC_KINDS,
  nowcTiles,
  RASRF_TIMES_URL,
  rasrfTiles,
  slmcsUrl,
} from "#lib/map/nowc.ts";
import { RAIN_TIMES_URL, rainTiles } from "#lib/map/rain.ts";
import {
  designatedRiverUrl,
  floodTiles,
  RISK_TIMES_URL,
  RISKS,
  riskTiles,
  RIVER_MAP_URL,
} from "#lib/map/risk.ts";
import {
  SNOW_FALL_HOURS,
  SNOW_TIMES_URL,
  snowOf,
  snowTiles,
} from "#lib/map/snow.ts";
import { baseStyle, type HazardId, HAZARDS } from "#lib/map/style.ts";
import { gsiSearchUrl } from "#lib/places.ts";
import { Relay, RELAY_SOURCES } from "#lib/server/relay.ts";

/**
 * 画面が組む中継の URL (`/relay/<源>/…`) が、どれもサーバーの許可の表 (`RELAY_SOURCES`) に通ること。
 * 表とずれると、画面では 400 になって層が出ない (docs/design.md の 2.14)
 */
function screenUrls(): string[] {
  const urls = new Set<string>();
  const collect = (v: unknown) => {
    for (const m of JSON.stringify(v).matchAll(/\/relay\/[^"\\\s]+/g))
      urls.add(m[0]);
  };
  const hazards: HazardId[] = ["none", ...HAZARDS.map((h) => h.id)];
  for (const id of hazards) collect(baseStyle("", id));
  collect(HAZARDS);
  const f = {
    basetime: "20261128070000",
    validtime: "20261128080000",
    member: "none",
  };
  for (const k of NOWC_KINDS) collect(nowcTiles(f, k.element));
  collect([rasrfTiles(f), slmcsUrl(f), RASRF_TIMES_URL]);
  collect([rainTiles(f), RAIN_TIMES_URL]);
  for (const k of RISKS) collect(riskTiles(f, k.element));
  collect([
    floodTiles(f),
    designatedRiverUrl(f),
    RISK_TIMES_URL,
    RIVER_MAP_URL,
  ]);
  collect(snowTiles(f, "snowd"));
  for (const h of SNOW_FALL_HOURS) {
    const kind = snowOf("snow-fall", h);
    if (kind) collect(snowTiles(f, kind.element));
  }
  collect(SNOW_TIMES_URL);
  collect(cameraPageRelay("10101"));
  collect(
    latestFrame('file_array[0]="../camera/315_820081B0/20261128121001.jpg"')
      ?.url,
  );
  collect(gsiSearchUrl("千代田区"));
  return [...urls];
}

test("画面が組む中継の URL は、どれもサーバーの許可の表に通る", async () => {
  const urls = screenUrls();
  // 層の数だけ集まっていること (集め方が壊れて 0 件で通らないように)
  expect(urls.length).toBeGreaterThan(30);
  const relay = new Relay({
    sources: RELAY_SOURCES,
    fetch: (async () => new Response("x")) as unknown as typeof fetch,
  });
  const refused: string[] = [];
  for (const raw of urls) {
    // MapLibre が埋める {z}/{x}/{y} に例の数を入れる
    const u = new URL(
      raw.replace("{z}", "8").replace("{x}", "227").replace("{y}", "100"),
      "https://s.example",
    );
    const [, , source = "", ...rest] = u.pathname.split("/");
    const headers = new Headers(
      source === "gsi-vector" ? { range: "bytes=0-16383" } : {},
    );
    const res = await relay.handle(
      source,
      decodeURIComponent(rest.join("/")),
      u.searchParams,
      headers,
    );
    if (res.status >= 400) refused.push(`${res.status} ${raw}`);
  }
  expect(refused).toEqual([]);
});
