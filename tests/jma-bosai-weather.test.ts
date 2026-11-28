import { describe, expect, test } from "bun:test";

import { sourceInTrouble, sourceStateText } from "#lib/format.ts";
import {
  isNotifiedBosai,
  type SourceStatus,
  warningsByOffice,
} from "#lib/model.ts";
import {
  BOSAI_AREA,
  BOSAI_INFORMATION,
  BOSAI_WARNING_MAP,
  bosaiDenbun,
  bosaiWeatherSource,
  parseBosaiAreas,
  parseBosaiDenbun,
  parseBosaiInformation,
  parseBosaiWarnings,
  primaryDown,
  STANDBY_GRACE_MS,
  WARNING_KIND_NAMES,
} from "#lib/server/sources/jma-bosai-weather.ts";
import { jmaWeatherSource } from "#lib/server/sources/jma.ts";

import {
  fixture,
  memoryStore,
  sourceContext,
  weatherInfo,
  weatherWarning,
} from "./helpers.ts";

const AREA = fixture("jma-bosai/area.json");
const MAP = fixture("jma-bosai/warning-map.json");
const INFORMATION = fixture("jma-bosai/information.json");
const DENBUN_NAME = "20261126190843_0_VPBS50_471000";
const DENBUN = fixture(`jma-bosai/${DENBUN_NAME}.json`);
const areas = parseBosaiAreas(AREA);

/** 全国の一覧の 1 項目を書き換えた作り物 (危険警報のある報が手元に無いため) */
function patchedMap(patch: (entries: Record<string, unknown>[]) => void) {
  const entries = JSON.parse(MAP) as Record<string, unknown>[];
  patch(entries);
  return JSON.stringify(entries);
}

describe("警報・注意報の一覧 (map.json)", () => {
  test("R06 の電文と同じ形の警報・注意報にする。名前は地域の表と別表 3 から", () => {
    const { warnings, unknown } = parseBosaiWarnings(MAP, areas);
    expect(unknown).toBe(0);
    expect(warnings.map((w) => w.warning.id)).toEqual([
      "VPWW55-140000",
      "VPWW56-140000",
      "VPWW58-140000",
      "VPWW59-140000",
      "VPWW61-140000",
    ]);
    const wind = warnings.find((w) => w.warning.code === "VPWW58");
    expect(wind?.key).toBe("VPWW58_140000_2026-11-27T19:47:28Z");
    expect(wind?.warning).toMatchObject({
      office: { code: "140000", name: "神奈川県" },
      status: "normal",
      infoType: "発表",
      reportedAt: "2026-11-28T04:47:00+09:00",
      headline: "神奈川県では、強風に注意してください。",
      source: "jma-bosai",
      released: [],
    });
    expect(wind?.warning.areas[0]).toEqual({
      code: "1410011",
      name: "横浜市北部",
      kinds: [{ code: "15", name: "強風注意報", level: 2, status: "発表" }],
    });
    // 解除だけの報は、出ている市町村等が無く、解除された市町村等だけを持つ
    const other = warnings.find((w) => w.warning.code === "VPWW61");
    expect(other?.warning.areas).toEqual([]);
    expect(other?.warning.released[0]?.kinds[0]).toMatchObject({
      code: "20",
      name: "濃霧注意報",
      status: "解除",
    });
  });

  test("段は種類のコードから。危険警報は府県予報区の詳しい内容で予備の印が付く", () => {
    const text = patchedMap((es) => {
      const e = es.find((x) => x.dataTypeCode === "VPWW56") as {
        warning: { class20Items: { kinds: unknown[] }[] };
      };
      const item = e.warning.class20Items[0];
      if (item) item.kinds = [{ code: "49", status: "発表" }];
    });
    const { warnings } = parseBosaiWarnings(text, areas);
    const sand = warnings.find((w) => w.warning.code === "VPWW56");
    expect(sand?.warning.areas[0]?.kinds[0]).toEqual({
      code: "49",
      name: "レベル４土砂災害危険警報",
      level: 4,
      status: "発表",
    });
    const [office] = warningsByOffice(
      warnings.map((w) => ({ ...w.warning, updatedAt: "" })),
    );
    expect(office?.top).toBe(4);
    expect(office?.bosai).toBe(true);
  });

  test("知らない種類のコードと、地域の表に無い府県予報区の報は採らない", () => {
    const text = patchedMap((es) => {
      const e = es[2] as { warning: { class20Items: { kinds: unknown[] }[] } };
      const item = e.warning.class20Items[0];
      if (item) item.kinds = [{ code: "99", status: "発表" }];
      (es[3] as { warning: { class10Items: unknown[] } }).warning.class10Items =
        [{ areaCode: "999999" }];
    });
    const { warnings, unknown } = parseBosaiWarnings(text, areas);
    expect(unknown).toBe(2);
    expect(warnings).toHaveLength(3);
    expect(() => parseBosaiWarnings('{"a":1}', areas)).toThrow();
    expect(() => parseBosaiAreas("[]")).toThrow();
  });

  test("種類の名前は、サンプル電文 (R06) の名前と同じ字", () => {
    for (const [file, code] of [
      ["15_16_01_241031_VPWW56.xml", "VPWW56"],
      ["15_16_04_251222_VPWW58.xml", "VPWW58"],
      ["15_16_06_241226_VPWW60.xml", "VPWW60"],
      ["15_16_07_250825_VPWW61.xml", "VPWW61"],
      ["15_17_01_251222_VPWW55.xml", "VPWW55"],
    ] as const) {
      const w = weatherWarning(file, code);
      for (const a of [...w.areas, ...w.released])
        for (const k of a.kinds)
          expect(WARNING_KIND_NAMES[k.code]).toBe(k.name);
    }
  });
});

describe("府県気象防災速報 (information.json と本文)", () => {
  test("一覧から府県気象防災速報だけを新しい順に", () => {
    expect(parseBosaiInformation(INFORMATION).map((i) => i.name)).toEqual([
      DENBUN_NAME,
      "20261126184841_0_VPBS50_471000",
    ]);
    expect(
      parseBosaiInformation(
        '[{"header":"VPBS50","jsonName":"../../x","datetime":"2026-11-26T19:08:41Z"}]',
      ),
    ).toEqual([]);
    expect(() => parseBosaiInformation("{}")).toThrow();
  });

  test("本文を気象庁 XML の VPBS50 と同じ形の報にする (id・一連の情報・情報タグ・地域)", () => {
    const info = parseBosaiDenbun(DENBUN);
    expect(info).toEqual({
      id: "VPBS50-HJPOK202611270408-20261127040800",
      kind: "bosai",
      code: "VPBS50",
      series: "bosai-HJPOK202611270408",
      status: "normal",
      infoType: "発表",
      reportedAt: "2026-11-27T04:08:00+09:00",
      title: "沖縄本島地方気象防災速報（線状降水帯発生）",
      headline:
        "沖縄県本島北部では、線状降水帯による非常に激しい雨が同じ場所で降り続いています。命に危険が及ぶ災害発生の危険度が急激に高まっています。",
      kindName: "線状降水帯発生",
      areas: [{ code: "471020", name: "本島北部" }],
      source: "jma-bosai",
    });
    if (info) expect(isNotifiedBosai(info)).toBe(true);
  });

  test("XML と同じく、記録雨だけの速報は採らず、取消は情報タグが無くても採る", () => {
    const d = JSON.parse(DENBUN) as {
      headlineInfo: { kind: { condition: string }[] }[];
      infoType: string;
    };
    const tag = d.headlineInfo[0]?.kind[0];
    if (tag) tag.condition = "記録雨";
    expect(parseBosaiDenbun(JSON.stringify(d))).toBeUndefined();
    d.headlineInfo = [];
    d.infoType = "取消";
    expect(parseBosaiDenbun(JSON.stringify(d))?.infoType).toBe("取消");
    expect(() => parseBosaiDenbun("[]")).toThrow();
  });

  test("XML の VPBS50 と同じ規則で id と一連の情報の鍵を作る", () => {
    const xml = weatherInfo("82_01_03_241031_VPBS50.xml", "VPBS50");
    expect(xml.id).toStartWith("VPBS50-");
    expect(xml.series).toStartWith("bosai-");
    expect(xml.source).toBeUndefined();
  });
});

describe("主の源が取れない間だけ取る", () => {
  const at = (iso: string) => Date.parse(iso);
  const base: SourceStatus = {
    id: "jma-weather",
    state: "connected",
    since: "2026-11-28T09:00:00.000Z",
    lastSeenAt: "2026-11-28T09:00:00.000Z",
  };

  test("取れている間と、取れなくなってすぐは待つ", () => {
    const now = at("2026-11-28T09:10:00Z");
    expect(primaryDown(base, now)).toBe(false);
    const retrying = { ...base, state: "retrying" as const };
    expect(primaryDown(retrying, at("2026-11-28T09:02:00Z"))).toBe(false);
    expect(
      primaryDown(retrying, at("2026-11-28T09:00:00Z") + STANDBY_GRACE_MS + 1),
    ).toBe(true);
    // 一度も取れていなければ、起動からの時間で決める
    const cold = {
      ...base,
      state: "connecting" as const,
      lastSeenAt: undefined,
    };
    expect(primaryDown(cold, at("2026-11-28T09:01:00Z"))).toBe(false);
    expect(primaryDown(cold, at("2026-11-28T09:04:00Z"))).toBe(true);
  });

  /** 気象 XML の情報源を、503 か時間切れで 1 回回す */
  async function runPrimary(mode: "503" | "timeout" | "up") {
    const { ctx } = sourceContext();
    const controller = new AbortController();
    const source = jmaWeatherSource(ctx, {
      fetch: (async () => {
        if (mode === "503") return new Response("busy", { status: 503 });
        if (mode === "timeout")
          throw new DOMException("The operation timed out.", "TimeoutError");
        return new Response(
          '<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>',
        );
      }) as unknown as typeof fetch,
      sleep: async () => controller.abort(),
      log: () => {},
    });
    await source.run(controller.signal);
    return source.status();
  }

  test.each(["503", "timeout"] as const)(
    "気象 XML が %s のときは予備に切り替え、取れたら戻す",
    async (mode) => {
      const down = await runPrimary(mode);
      expect(down.state).toBe("stopped");
      expect(down.lastError).toBeTruthy();
      // 止める前の状態 (retrying) で、猶予が過ぎたら予備を取得する
      const retrying = { ...down, state: "retrying" as const };
      expect(primaryDown(retrying, Date.now())).toBe(false);
      expect(primaryDown(retrying, Date.now() + STANDBY_GRACE_MS + 1)).toBe(
        true,
      );
      const up = await runPrimary("up");
      expect(up.lastError).toBeUndefined();
      expect(
        primaryDown({ ...up, state: "connected" }, Date.now() + 60 * 60_000),
      ).toBe(false);
    },
  );

  test("予備は主が取れない間だけ取得し、主が戻ったら取得しない", async () => {
    const { ctx, got } = sourceContext();
    const urls: string[] = [];
    const headers: Record<string, Record<string, string>> = {};
    let primary: SourceStatus = { ...base };
    const now = at("2026-11-28T09:20:00Z");
    let step = 0;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const source = bosaiWeatherSource(ctx, {
      primary: () => primary,
      now: () => now,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(url);
        headers[url] = init.headers as Record<string, string>;
        if (url === BOSAI_AREA) return new Response(AREA);
        if (url === BOSAI_WARNING_MAP)
          return headers[url]?.["if-none-match"]
            ? new Response(null, { status: 304 })
            : new Response(MAP, { headers: { etag: 'W/"m1"' } });
        if (url === BOSAI_INFORMATION)
          return new Response(INFORMATION, { headers: { etag: 'W/"i1"' } });
        if (url === bosaiDenbun(DENBUN_NAME)) return new Response(DENBUN);
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          step++;
          release = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      log: () => {},
    });
    const running = source.run(controller.signal);
    const next = async () => {
      const r = release;
      release = undefined;
      r?.();
      await Bun.sleep(20);
    };
    await Bun.sleep(20);
    // 1 回目: 主は取れている。何も取得しない
    expect(urls).toEqual([]);
    expect(source.status().state).toBe("standby");
    expect(sourceStateText(source.status())).toBe(
      "待機中 (気象庁 XML (気象) が取れない間だけ取ります)",
    );
    expect(sourceInTrouble(source.status())).toBe(false);

    // 主が 15 分取れていない (最後に取れたのは 2 日前の夕方)。2 回目に取得する
    primary = {
      ...base,
      state: "retrying",
      lastError: "Error: フィードが 503 を返しました",
      lastSeenAt: "2026-11-26T19:00:00.000Z",
    };
    await next();
    expect(urls).toEqual([
      BOSAI_AREA,
      BOSAI_WARNING_MAP,
      BOSAI_INFORMATION,
      bosaiDenbun(DENBUN_NAME),
    ]);
    expect(headers[BOSAI_WARNING_MAP]?.["user-agent"]).toBe(
      "sonae (+https://github.com/danything/sonae)",
    );
    // 主が最後に取れた時刻 (の 10 分前) より前の報は採らない
    expect(got.map((m) => m.key)).toEqual([
      "VPWW58_140000_2026-11-27T19:47:28Z",
      "VPWW59_140000_2026-11-27T19:47:28Z",
      "VPWW61_140000_2026-11-28T07:04:35Z",
      DENBUN_NAME,
    ]);
    expect(got.every((m) => m.source === "jma-bosai-weather")).toBe(true);
    expect(source.status().state).toBe("connected");

    // 3 回目: 変わっていなければ一覧は 304。受けた速報の本文は取り直さない
    await next();
    expect(urls.slice(4)).toEqual([BOSAI_WARNING_MAP, BOSAI_INFORMATION]);
    expect(headers[BOSAI_WARNING_MAP]?.["if-none-match"]).toBe('W/"m1"');
    expect(got).toHaveLength(4);

    // 主が戻った。4 回目からは取得しない
    primary = { ...base, lastSeenAt: "2026-11-28T09:19:00.000Z" };
    const before = urls.length;
    await next();
    await next();
    expect(urls).toHaveLength(before);
    expect(source.status().state).toBe("standby");
    controller.abort();
    await running;
    expect(step).toBeGreaterThanOrEqual(5);
  });

  test("予備の取得に失敗したら状態にエラーを出し、間隔を空ける", async () => {
    const { ctx } = sourceContext();
    const waits: number[] = [];
    const controller = new AbortController();
    const source = bosaiWeatherSource(ctx, {
      primary: () => ({
        ...base,
        state: "retrying",
        lastSeenAt: "2026-11-28T08:00:00.000Z",
      }),
      now: () => at("2026-11-28T09:20:00Z"),
      fetch: (async () =>
        new Response("busy", { status: 503 })) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 3) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(source.status().lastError).toContain("503");
  });
});

describe("気象庁 XML との重なり (store)", () => {
  const bosaiWind = () => {
    const w = parseBosaiWarnings(MAP, areas).warnings.find(
      (x) => x.warning.code === "VPWW58",
    );
    if (!w) throw new Error("無い");
    return w.warning;
  };

  test("同じ時刻の報は、予備を気象庁 XML で置き換え、気象庁 XML を予備で置き換えない", () => {
    const { store } = memoryStore();
    const w = bosaiWind();
    expect(store.ingest(warningIncoming("jma-bosai-weather", w))).toHaveLength(
      1,
    );
    const xml = { ...w, source: undefined };
    const [replaced] = store.ingest(warningIncoming("jma-weather", xml));
    expect(replaced?.type === "warning" && replaced.data.source).toBe(
      undefined,
    );
    // XML の後に来た予備の同じ報は捨てる
    expect(store.ingest(warningIncoming("jma-bosai-weather", w, "2"))).toEqual(
      [],
    );
    // 予備の新しい報は採る
    const newer = { ...w, reportedAt: "2026-11-28T05:47:00+09:00" };
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", newer, "3")),
    ).toHaveLength(1);
  });

  test("気象防災速報: 受けている報は予備で採らず、予備の後の気象庁 XML で置き換える", () => {
    const { store } = memoryStore();
    const info = parseBosaiDenbun(DENBUN);
    if (!info) throw new Error("無い");
    const incoming = (
      source: "jma-bosai-weather" | "jma-weather",
      key: string,
      i = info,
    ) => ({
      source,
      key,
      code: "VPBS50",
      items: [{ type: "weather" as const, info: i }],
    });
    expect(store.ingest(incoming("jma-bosai-weather", "a"))).toHaveLength(1);
    expect(store.ingest(incoming("jma-bosai-weather", "b"))).toEqual([]);
    const [xml] = store.ingest(
      incoming("jma-weather", "c", { ...info, source: undefined }),
    );
    expect(xml?.type === "weather" && xml.data.source).toBe(undefined);
    expect(store.ingest(incoming("jma-bosai-weather", "d"))).toEqual([]);
  });
});

function warningIncoming(
  source: "jma-bosai-weather" | "jma-weather",
  warning: ReturnType<typeof parseBosaiWarnings>["warnings"][number]["warning"],
  key = "1",
) {
  return {
    source,
    key: `${source}-${key}`,
    code: warning.code,
    items: [{ type: "warning" as const, warning }],
  };
}
