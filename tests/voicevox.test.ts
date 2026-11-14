import { describe, expect, test } from "bun:test";

import { OPENINGS, SAMPLE } from "#lib/readout.ts";
import type { Reading } from "#lib/server/readings.ts";
import { serveSpeech, Voicevox } from "#lib/server/voicevox.ts";
import { DEFAULT_SPEAKER } from "#lib/voices.ts";

import { eew, NOW } from "./events.ts";

/** VOICEVOX のエンジンの代わり。合成した (speaker, text) を控え、WAV の代わりに字を返す */
function fakeEngine(opts: { down?: boolean } = {}) {
  const synth: string[] = [];
  const dict = new Map<
    string,
    { surface: string; pronunciation: string; accent_type: number }
  >();
  let n = 0;
  let down = opts.down ?? false;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (down) throw new TypeError("connection refused");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const q = url.searchParams;
    switch (`${method} ${url.pathname}`) {
      case "GET /version":
        return Response.json("0.26.1");
      case "GET /speakers":
        return Response.json([
          {
            name: "剣崎雌雄",
            speaker_uuid: "1a17ca16-7ee5-4ea5-b191-2f02ace24d21",
            styles: [{ name: "ノーマル", id: 21, type: "talk" }],
          },
          {
            name: "雀松朱司",
            speaker_uuid: "0acebdee-a4a5-4e12-a695-e19609728e30",
            styles: [{ name: "ノーマル", id: 52, type: "talk" }],
          },
          {
            // 規約で外したキャラクター
            name: "青山龍星",
            speaker_uuid: "4f51116a-d9ee-4516-925d-21f183e2afad",
            styles: [{ name: "ノーマル", id: 13, type: "talk" }],
          },
        ]);
      case "GET /user_dict":
        return Response.json(Object.fromEntries(dict));
      case "POST /user_dict_word": {
        const id = `w${++n}`;
        dict.set(id, {
          surface: q.get("surface") ?? "",
          pronunciation: q.get("pronunciation") ?? "",
          accent_type: Number(q.get("accent_type")),
        });
        return new Response(id);
      }
      case "POST /audio_query":
        return Response.json({
          text: q.get("text"),
          speaker: q.get("speaker"),
        });
      case "POST /synthesis": {
        const body = JSON.parse(String(init?.body)) as {
          text: string;
          speaker: string;
        };
        synth.push(`${body.speaker}:${body.text}`);
        return new Response(`${body.speaker}:${body.text}`);
      }
    }
    if (method === "PUT" && url.pathname.startsWith("/user_dict_word/")) {
      const id = url.pathname.split("/").at(-1) ?? "";
      dict.set(id, {
        surface: q.get("surface") ?? "",
        pronunciation: q.get("pronunciation") ?? "",
        accent_type: Number(q.get("accent_type")),
      });
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    f,
    synth,
    dict,
    setDown(v: boolean) {
      down = v;
    },
  };
}

const settle = async (v: Voicevox) => {
  // 列が空になるまで待つ (合成は順に 1 つずつ)
  for (let i = 0; i < 50; i++) await Promise.resolve().then(() => Bun.sleep(1));
  return v;
};

const text = async (r: Response) =>
  new TextDecoder().decode(await r.arrayBuffer());

describe("VOICEVOX", () => {
  test("つながったら、規約を確かめた声だけを選べるようにし、辞書を足し、既定の声の決まった文を合成しておく", async () => {
    const e = fakeEngine();
    const v = new Voicevox({
      url: "http://vv:50021/",
      fetch: e.f,
      now: () => NOW,
    });
    expect(await v.check()).toBe(true);
    expect(v.info().voices.map((x) => x.id)).toEqual([21, 52]);
    expect([...e.dict.values()].some((w) => w.surface === "渡島")).toBe(true);
    await settle(v);
    expect(v.isCached(DEFAULT_SPEAKER, OPENINGS.eewWarning)).toBe(true);
    expect(v.isCached(52, OPENINGS.eewWarning)).toBe(false);
  });

  test("辞書は足りない語だけを足し、読みが違えば直す", async () => {
    const e = fakeEngine();
    const v = new Voicevox({ url: "http://vv:50021", fetch: e.f });
    const words: Reading[] = [
      { surface: "日向灘", pronunciation: "ヒュウガナダ", accent: 3 },
    ];
    expect(await v.syncDictionary(words)).toBe(1);
    expect(await v.syncDictionary(words)).toBe(0);
    expect(
      await v.syncDictionary([
        { surface: "日向灘", pronunciation: "ヒュウガナダ", accent: 0 },
      ]),
    ).toBe(1);
    expect(e.dict.size).toBe(1);
  });

  test("事象を受けたら変わる文を合成する。受けていない文は読ませない", async () => {
    const e = fakeEngine();
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
    });
    await v.check();
    await settle(v);
    const before = e.synth.length;
    v.handle(
      eew({
        kind: "warning",
        hypocenter: { name: "日向灘" },
        warnAreas: ["宮崎県南部平野部"],
      }),
    );
    await settle(v);
    const made = e.synth.slice(before);
    expect(made).toEqual([
      "21:強い揺れに警戒が必要な地域は、宮崎県南部平野部です。",
      "21:震源は日向灘です。",
    ]);
    const r = await serveSpeech(v, { text: "震源は日向灘です。" });
    expect(r.status).toBe(200);
    expect(await text(r)).toBe("21:震源は日向灘です。");
    // 同じ文は合成し直さない (持っている音を返す)
    expect(e.synth.length).toBe(before + 2);
    expect((await serveSpeech(v, { text: "勝手な文です。" })).status).toBe(404);
  });

  test("選んだ声の冒頭がまだ無いときは、既定の声の冒頭を返し、選んだ声を後ろで合成する。試しの文は選んだ声を待つ", async () => {
    const e = fakeEngine();
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
    });
    await v.check();
    await settle(v);
    const r = await serveSpeech(v, { text: OPENINGS.eewWarning, voice: 52 });
    expect(r.headers.get("x-voice")).toBe("21");
    await settle(v);
    expect(v.isCached(52, OPENINGS.eewWarning)).toBe(true);
    const again = await serveSpeech(v, {
      text: OPENINGS.eewWarning,
      voice: 52,
    });
    expect(again.headers.get("x-voice")).toBe("52");
    // 使われている声には、事象の文も合成しておく
    expect(v.voicesInUse()).toEqual([21, 52]);
    const sample = await serveSpeech(v, { text: SAMPLE, voice: 52 });
    expect(sample.headers.get("x-voice")).toBe("52");
    // 規約で外した声は選べない (既定の声で読む)
    const other = await serveSpeech(v, { text: SAMPLE, voice: 13 });
    expect(other.headers.get("x-voice")).toBe("21");
  });

  test("つながらないときは 503 (画面は端末の読み上げで読む)", async () => {
    const e = fakeEngine({ down: true });
    const v = new Voicevox({ url: "http://vv:50021", fetch: e.f });
    expect(await v.check()).toBe(false);
    expect((await serveSpeech(v, { text: SAMPLE })).status).toBe(503);
    expect(v.info().available).toBe(false);
  });

  test("音は上限を超えたら古いものから捨てる。決まった文は捨てない", async () => {
    const e = fakeEngine();
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
      maxBytes: 400,
    });
    await v.check();
    await settle(v);
    for (let i = 0; i < 20; i++) {
      v.handle(
        eew({
          eventId: `e${i}`,
          kind: "warning",
          hypocenter: { name: `震源${i}` },
          warnAreas: [],
        }),
      );
    }
    await settle(v);
    expect(v.isCached(21, "震源は震源0です。")).toBe(false);
    expect(v.isCached(21, "震源は震源19です。")).toBe(true);
    expect(v.isCached(21, OPENINGS.eewWarning)).toBe(true);
  });
});
