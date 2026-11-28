import { describe, expect, test } from "bun:test";

import { planAlerts } from "#lib/alert.ts";
import { sourceInTrouble, sourceStateText } from "#lib/format.ts";
import {
  isNotifiedBosai,
  type SourceStatus,
  warningsByOffice,
} from "#lib/model.ts";
import { contentOf } from "#lib/notify.ts";
import {
  BOSAI_AREA,
  BOSAI_INFORMATION,
  BOSAI_WARNING_MAP,
  bosaiDenbun,
  bosaiWeatherSource,
  MAP_MIN_INTERVAL_MS,
  parseBosaiAreas,
  parseBosaiDenbun,
  parseBosaiInformation,
  parseBosaiWarnings,
  primaryDown,
  STANDBY_GRACE_MS,
  WARNING_KIND_NAMES,
} from "#lib/server/sources/jma-bosai-weather.ts";
import { jmaWeatherSource } from "#lib/server/sources/jma.ts";

import { prefs } from "./events.ts";
import {
  fixture,
  homeAt,
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
    // 回ごとに時計を進める (全国の一覧を取りに行く最短の間隔があるため)
    let now = at("2026-11-28T09:20:00Z");
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
    now += MAP_MIN_INTERVAL_MS;
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

  test("予備の取得に失敗したら状態にエラーを出し、続けて取れない一覧の間を倍々に空ける", async () => {
    const { ctx } = sourceContext();
    let t = at("2026-11-28T09:20:00Z");
    /** 一覧 (警報) を取りに行った時刻 (分) */
    const asked: number[] = [];
    let rounds = 0;
    const controller = new AbortController();
    const source = bosaiWeatherSource(ctx, {
      primary: () => ({
        ...base,
        state: "retrying",
        lastSeenAt: "2026-11-28T08:00:00.000Z",
      }),
      now: () => t,
      fetch: (async (url: string) => {
        if (url === BOSAI_AREA)
          asked.push((t - at("2026-11-28T09:20:00Z")) / 60_000);
        return new Response("busy", { status: 503 });
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        expect(ms).toBe(60_000);
        t += ms;
        if (++rounds >= 8) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    // 0・1・3・7 分目 (間は 1・2・4 分)
    expect(asked).toEqual([0, 1, 3, 7]);
    expect(source.status().lastError).toContain("503");
  });

  test("待ちを延ばしている間に主が戻れば、待ちが明けるのを待たずに待機に戻る", async () => {
    const { ctx } = sourceContext();
    let primaryOk = false;
    let sleeps = 0;
    const states: string[] = [];
    const controller = new AbortController();
    const source = bosaiWeatherSource(ctx, {
      primary: () =>
        primaryOk
          ? base
          : {
              ...base,
              state: "retrying",
              lastSeenAt: "2026-11-28T08:00:00.000Z",
            },
      now: () => at("2026-11-28T09:20:00Z"),
      fetch: (async () =>
        new Response("busy", { status: 503 })) as unknown as typeof fetch,
      sleep: async () => {
        sleeps++;
        states.push(source.status().state);
        // 4 回失敗して 8 分待ちに入った後の、1 分目に主が戻る
        if (sleeps === 1 + 1 + 2 + 4 + 1) primaryOk = true;
        if (sleeps >= 11) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    expect(states.at(-1)).toBe("standby");
    expect(states.filter((s) => s === "standby").length).toBeGreaterThan(0);
  });

  test("警報・注意報の一覧が取れなくても、気象防災速報は取る", async () => {
    const { ctx, got } = sourceContext();
    const controller = new AbortController();
    const source = bosaiWeatherSource(ctx, {
      primary: () => ({
        ...base,
        state: "retrying",
        lastSeenAt: "2026-11-26T19:00:00.000Z",
      }),
      now: () => at("2026-11-28T09:20:00Z"),
      fetch: (async (url: string) => {
        if (url === BOSAI_AREA) return new Response(AREA);
        if (url === BOSAI_INFORMATION) return new Response(INFORMATION);
        if (url === bosaiDenbun(DENBUN_NAME)) return new Response(DENBUN);
        return new Response("busy", { status: 503 });
      }) as unknown as typeof fetch,
      sleep: async () => controller.abort(),
      log: () => {},
    });
    await source.run(controller.signal);
    expect(got.map((m) => m.key)).toEqual([DENBUN_NAME]);
    expect(source.status().lastError).toContain("map.json");
  });

  test("採れなかった報があっても控えは覚え、変わっていない一覧は取り直さずに手元の本文で読み直す", async () => {
    const { ctx } = sourceContext();
    const conditional: boolean[] = [];
    let rounds = 0;
    let now = at("2026-11-28T09:20:00Z");
    let parsedAgain = 0;
    const controller = new AbortController();
    const text = patchedMap((es) => {
      const e = es[2] as { warning: { class20Items: { kinds: unknown[] }[] } };
      const item = e.warning.class20Items[0];
      if (item) item.kinds = [{ code: "99", status: "発表" }];
    });
    const source = bosaiWeatherSource(ctx, {
      primary: () => ({
        ...base,
        state: "retrying",
        lastSeenAt: "2026-11-26T19:00:00.000Z",
      }),
      now: () => now,
      fetch: (async (url: string, init: RequestInit) => {
        if (url === BOSAI_AREA) return new Response(AREA);
        if (url === BOSAI_WARNING_MAP) {
          const h = init.headers as Record<string, string>;
          conditional.push(!!h["if-none-match"]);
          if (h["if-none-match"] === 'W/"m1"') {
            parsedAgain++;
            return new Response(null, { status: 304 });
          }
          return new Response(text, {
            headers: {
              etag: 'W/"m1"',
              "last-modified": "Sat, 28 Nov 2026 09:19:00 GMT",
            },
          });
        }
        return new Response("[]");
      }) as unknown as typeof fetch,
      sleep: async () => {
        now += MAP_MIN_INTERVAL_MS;
        if (++rounds >= 2) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    // 2 回目も条件を付け、304 なら手元の本文を読み直す (本体は運ばない)
    expect(conditional).toEqual([false, true]);
    expect(parsedAgain).toBe(1);
  });

  test("全国の一覧は 1 分より短い間隔では取りに行かず、ETag と Last-Modified の両方を付ける", async () => {
    const { ctx } = sourceContext();
    const maps: Record<string, string>[] = [];
    let rounds = 0;
    let now = at("2026-11-28T09:20:00Z");
    const controller = new AbortController();
    const source = bosaiWeatherSource(ctx, {
      primary: () => ({
        ...base,
        state: "retrying",
        lastSeenAt: "2026-11-26T19:00:00.000Z",
      }),
      now: () => now,
      fetch: (async (url: string, init: RequestInit) => {
        if (url === BOSAI_AREA) return new Response(AREA);
        if (url === BOSAI_WARNING_MAP) {
          maps.push(init.headers as Record<string, string>);
          return maps.length > 1
            ? new Response(null, { status: 304 })
            : new Response(MAP, {
                headers: {
                  etag: 'W/"m1"',
                  "last-modified": "Sat, 28 Nov 2026 09:19:00 GMT",
                },
              });
        }
        return new Response("[]");
      }) as unknown as typeof fetch,
      sleep: async () => {
        // 1 回目の後は 30 秒 (間隔の中)、2 回目の後は 1 分進める
        now += rounds === 0 ? 30_000 : MAP_MIN_INTERVAL_MS;
        if (++rounds >= 3) controller.abort();
      },
      log: () => {},
    });
    await source.run(controller.signal);
    // 3 回のうち、全国の一覧を取りに行ったのは 1 回目と 3 回目だけ
    expect(maps).toHaveLength(2);
    expect(maps[1]?.["if-none-match"]).toBe('W/"m1"');
    expect(maps[1]?.["if-modified-since"]).toBe(
      "Sat, 28 Nov 2026 09:19:00 GMT",
    );
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

describe("予備で受けた訂正 (store)", () => {
  test("警報・注意報: 気象庁 XML の同じ時刻の報があっても、予備の訂正は採る。同じ訂正の受け直しと XML の訂正の置き換えはしない", () => {
    const { store } = memoryStore();
    const w = parseBosaiWarnings(MAP, areas).warnings.find(
      (x) => x.warning.code === "VPWW58",
    )?.warning;
    if (!w) throw new Error("無い");
    store.ingest(warningIncoming("jma-weather", { ...w, source: undefined }));
    const fix = { ...w, infoType: "訂正" as const };
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix, "2")),
    ).toHaveLength(1);
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix, "3")),
    ).toEqual([]);
    // XML の訂正は予備の訂正を置き換え、その後の予備の訂正では置き換えない
    expect(
      store.ingest(
        warningIncoming("jma-weather", { ...fix, source: undefined }, "4"),
      ),
    ).toHaveLength(1);
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix, "5")),
    ).toEqual([]);
  });

  test("気象防災速報: 受けている報 (気象庁 XML) の訂正を予備で受けたら置き換え、同じ訂正は受け直さない", () => {
    const { store } = memoryStore();
    const info = parseBosaiDenbun(DENBUN);
    if (!info) throw new Error("無い");
    const incoming = (
      source: "jma-bosai-weather" | "jma-weather",
      key: string,
      i: typeof info,
    ) => ({
      source,
      key,
      code: "VPBS50",
      items: [{ type: "weather" as const, info: i }],
    });
    store.ingest(incoming("jma-weather", "a", { ...info, source: undefined }));
    const fix = {
      ...info,
      infoType: "訂正" as const,
      headline: "訂正した見出し",
    };
    const [got] = store.ingest(incoming("jma-bosai-weather", "b", fix));
    expect(got?.type === "weather" && got.data.headline).toBe("訂正した見出し");
    expect(got?.type === "weather" && got.data.id).toBe(info.id);
    expect(store.ingest(incoming("jma-bosai-weather", "c", fix))).toEqual([]);
  });
});

describe("予備の訂正と気象庁 XML の重なり (store、監査の残り)", () => {
  const wind = () => {
    const w = parseBosaiWarnings(MAP, areas).warnings.find(
      (x) => x.warning.code === "VPWW58",
    )?.warning;
    if (!w) throw new Error("無い");
    return w;
  };

  test("予備の訂正の後に、同じ時刻の気象庁 XML の訂正でない報が来ても、訂正前に戻さない", () => {
    const { store } = memoryStore();
    const w = wind();
    store.ingest(warningIncoming("jma-weather", { ...w, source: undefined }));
    const fix = { ...w, infoType: "訂正" as const, headline: "訂正した見出し" };
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix, "2")),
    ).toHaveLength(1);
    expect(
      store.ingest(
        warningIncoming("jma-weather", { ...w, source: undefined }, "3"),
      ),
    ).toEqual([]);
    expect(warningOf(store, w.id)?.headline).toBe("訂正した見出し");
  });

  test("予備の訂正の訂正: 中身が違えば採り、同じなら採らない (警報・注意報)", () => {
    const { store } = memoryStore();
    const w = wind();
    const fix1 = { ...w, infoType: "訂正" as const, headline: "一度目" };
    const fix2 = { ...w, infoType: "訂正" as const, headline: "二度目" };
    store.ingest(warningIncoming("jma-bosai-weather", w));
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix1, "2")),
    ).toHaveLength(1);
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix1, "3")),
    ).toEqual([]);
    expect(
      store.ingest(warningIncoming("jma-bosai-weather", fix2, "4")),
    ).toHaveLength(1);
    expect(warningOf(store, w.id)?.headline).toBe("二度目");
  });

  test("予備の訂正の後に同じ中身の気象庁 XML の訂正を受けても、通知の中身は変わらない (鳴らし直さない)", () => {
    const { store } = memoryStore();
    const w = wind();
    const fix = { ...w, infoType: "訂正" as const };
    const [a] = store.ingest(warningIncoming("jma-bosai-weather", fix));
    const [b] = store.ingest(
      warningIncoming("jma-weather", { ...fix, source: undefined }, "2"),
    );
    if (a?.type !== "warning" || b?.type !== "warning") throw new Error("無い");
    const home = homeAt(w.areas[0]?.code ?? "");
    const at = Date.parse(w.reportedAt) + 60_000;
    const content = (e: typeof a) =>
      planAlerts(e, at, prefs({ home }), new Map(), null).map((p) =>
        contentOf(p.notice),
      );
    expect(content(a).length).toBeGreaterThan(0);
    expect(content(b)).toEqual(content(a));
  });

  test("気象の報: 予備の訂正の訂正は中身が違えば採り、訂正は同じ時刻の報を置き換える (後の報の行を上書きしない)", () => {
    const { store } = memoryStore();
    const info = parseBosaiDenbun(DENBUN);
    if (!info) throw new Error("無い");
    const incoming = (
      source: "jma-bosai-weather" | "jma-weather",
      key: string,
      i: typeof info,
    ) => ({
      source,
      key,
      code: "VPBS50",
      items: [{ type: "weather" as const, info: i }],
    });
    const xml = { ...info, source: undefined };
    const later = {
      ...xml,
      id: `${info.id}-later`,
      reportedAt: new Date(
        Date.parse(info.reportedAt) + 30 * 60_000,
      ).toISOString(),
      headline: "後の報",
    };
    store.ingest(incoming("jma-weather", "a", xml));
    store.ingest(incoming("jma-weather", "b", later));
    // 前の報 (後の報ではない) の訂正
    const fix1 = { ...info, infoType: "訂正" as const, headline: "一度目" };
    const [got] = store.ingest(incoming("jma-bosai-weather", "c", fix1));
    expect(got?.type === "weather" && got.data.id).toBe(info.id);
    expect(store.weatherInfo(later.id)?.headline).toBe("後の報");
    expect(store.ingest(incoming("jma-bosai-weather", "d", fix1))).toEqual([]);
    const fix2 = { ...fix1, headline: "二度目" };
    expect(store.ingest(incoming("jma-bosai-weather", "e", fix2))).toHaveLength(
      1,
    );
    expect(store.weatherInfo(info.id)?.headline).toBe("二度目");
  });
});

const at2 = (iso: string) => Date.parse(iso);
const base2: SourceStatus = {
  id: "jma-weather",
  state: "connected",
  since: "2026-11-28T09:00:00.000Z",
};
test("気象防災速報の本文が取り直しても取れない失敗 (403 など) なら、一覧に載っている間は取り直さない", async () => {
  const { ctx } = sourceContext();
  let denbun = 0;
  let rounds = 0;
  const controller = new AbortController();
  const source = bosaiWeatherSource(ctx, {
    primary: () => ({
      ...base2,
      state: "retrying",
      lastSeenAt: "2026-11-26T19:00:00.000Z",
    }),
    now: () => at2("2026-11-28T09:20:00Z"),
    fetch: (async (url: string) => {
      if (url === BOSAI_AREA) return new Response(AREA);
      if (url === BOSAI_INFORMATION) return new Response(INFORMATION);
      if (url === bosaiDenbun(DENBUN_NAME)) {
        denbun++;
        return new Response("forbidden", { status: 403 });
      }
      return new Response("[]");
    }) as unknown as typeof fetch,
    sleep: async () => {
      if (++rounds >= 3) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  expect(denbun).toBe(1);
});

test("警報の一覧が続けて取れなくても、気象防災速報の一覧は 1 分ごとに取る (一覧ごとに間を空ける)", async () => {
  const { ctx } = sourceContext();
  let t = at2("2026-11-28T09:20:00Z");
  const asked = new Map<string, number>();
  let rounds = 0;
  const controller = new AbortController();
  const source = bosaiWeatherSource(ctx, {
    primary: () => ({
      ...base2,
      state: "retrying",
      lastSeenAt: "2026-11-28T08:00:00.000Z",
    }),
    now: () => t,
    fetch: (async (url: string) => {
      asked.set(url, (asked.get(url) ?? 0) + 1);
      if (url === BOSAI_AREA) return new Response(AREA);
      if (url === BOSAI_WARNING_MAP)
        return new Response("busy", { status: 503 });
      return new Response("[]");
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      expect(ms).toBe(60_000);
      t += ms;
      if (++rounds >= 8) controller.abort();
    },
    log: () => {},
  });
  await source.run(controller.signal);
  expect(asked.get(BOSAI_INFORMATION)).toBe(8);
  // 0・1・3・7 分目 (間は 1・2・4 分)
  expect(asked.get(BOSAI_WARNING_MAP)).toBe(4);
});

/** store の手元の警報・注意報 (試験用。store の外からは読まない) */
function warningOf(
  store: ReturnType<typeof memoryStore>["store"],
  id: string,
): { headline: string } | undefined {
  return (
    store as unknown as {
      warning(id: string): { headline: string } | undefined;
    }
  ).warning(id);
}
