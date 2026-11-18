import { describe, expect, test } from "bun:test";

import { OPENINGS, SAMPLE } from "#lib/readout.ts";
import { openDb } from "#lib/server/db.ts";
import { type Reading, READINGS } from "#lib/server/readings.ts";
import { readSetting, voiceStore, writeSetting } from "#lib/server/settings.ts";
import {
  changeVoice,
  serveSpeech,
  Voicevox,
  wavSeconds,
} from "#lib/server/voicevox.ts";
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
            styles: [
              { name: "ノーマル", id: 52, type: "talk" },
              // 声の数の上限を試すための架空のスタイル
              { name: "試し1", id: 901, type: "talk" },
              { name: "試し2", id: 902, type: "talk" },
              { name: "試し3", id: 903, type: "talk" },
            ],
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
    expect(v.info().voices.map((x) => x.id)).toEqual([21, 52, 901, 902, 903]);
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

  test("前の確かめが終わる前に次の確かめが来ても重ねて走らせず、辞書に同じ語を二重に足さない", async () => {
    const e = fakeEngine();
    const v = new Voicevox({ url: "http://vv:50021", fetch: e.f });
    // エンジンが遅く、1 分ごとの次の回が前の回の途中で始まったとき
    const [a, b] = await Promise.all([v.check(), v.check()]);
    expect([a, b]).toEqual([true, true]);
    expect(e.dict.size).toBe(READINGS.length);
    // 終わった後の確かめはまた走る (足りない語は無い)
    expect(await v.check()).toBe(true);
    expect(e.dict.size).toBe(READINGS.length);
    await settle(v);
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
    const r = await serveSpeech(v, "震源は日向灘です。");
    expect(r.status).toBe(200);
    expect(await text(r)).toBe("21:震源は日向灘です。");
    // 同じ文は合成し直さない (持っている音を返す)
    expect(e.synth.length).toBe(before + 2);
    expect((await serveSpeech(v, "勝手な文です。")).status).toBe(404);
  });

  test("つながらないときは 503 (画面は端末の読み上げで読む)", async () => {
    const e = fakeEngine({ down: true });
    const v = new Voicevox({ url: "http://vv:50021", fetch: e.f });
    expect(await v.check()).toBe(false);
    expect((await serveSpeech(v, SAMPLE)).status).toBe(503);
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

  test("声を替えると覚え、新しい声で決まった文をすぐ合成し直し、知らせる。前の声の決まった文は捨てられる", async () => {
    const e = fakeEngine();
    const saved: [number, string][] = [];
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
      maxBytes: 400,
      store: { load: () => undefined, save: (id, by) => saved.push([id, by]) },
    });
    const heard: number[] = [];
    v.onVoice((id) => heard.push(id));
    await v.check();
    await settle(v);
    expect(v.info().voice).toBe(21);
    expect(v.setVoice(52, "sub-1")).toBe(true);
    expect(saved).toEqual([[52, "sub-1"]]);
    expect(heard).toEqual([52]);
    expect(v.info().voice).toBe(52);
    await settle(v);
    expect(v.isCached(52, OPENINGS.eewWarning)).toBe(true);
    // 上限を超えたので、前の声 (21) の決まった文から捨てた
    expect(v.isCached(21, OPENINGS.eewWarning)).toBe(false);
    // 同じ声を選び直しても、合成も知らせもしない
    const before = e.synth.length;
    expect(v.setVoice(52, "sub-2")).toBe(true);
    await settle(v);
    expect(e.synth.length).toBe(before);
    expect(heard).toEqual([52]);
    // 規約で外した声・エンジンに無い声は選べない
    expect(v.setVoice(13, "sub-1")).toBe(false);
    expect(v.setVoice(999, "sub-1")).toBe(false);
    expect(v.info().voice).toBe(52);
  });

  test("事象の文は選んである声 1 つだけで合成し、音も選んである声で返す (端末は声を送らない)", async () => {
    const e = fakeEngine();
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
      store: { load: () => 52, save: () => {} },
    });
    await v.check();
    await settle(v);
    // 決まった文も、既定の声 (21) では合成しない
    expect(e.synth.every((s) => s.startsWith("52:"))).toBe(true);
    expect(v.isCached(21, OPENINGS.eewWarning)).toBe(false);
    const before = e.synth.length;
    v.handle(
      eew({
        kind: "warning",
        hypocenter: { name: "日向灘" },
        warnAreas: ["宮崎県南部平野部"],
      }),
    );
    await settle(v);
    expect(e.synth.slice(before)).toEqual([
      "52:強い揺れに警戒が必要な地域は、宮崎県南部平野部です。",
      "52:震源は日向灘です。",
    ]);
    const r = await serveSpeech(v, "震源は日向灘です。");
    expect(r.headers.get("x-voice")).toBe("52");
    const sample = await serveSpeech(v, SAMPLE);
    expect(sample.headers.get("x-voice")).toBe("52");
  });

  test("覚えた声はつながって声の一覧を読むまで既定の声。読めたら知らせる。一覧から無くなったら既定の声", async () => {
    const e = fakeEngine();
    const heard: number[] = [];
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
      store: { load: () => 901, save: () => {} },
    });
    v.onVoice((id) => heard.push(id));
    expect(v.speaker).toBe(21);
    await v.check();
    expect(v.speaker).toBe(901);
    expect(heard).toEqual([901]);
    const gone = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      store: { load: () => 13, save: () => {} },
    });
    await gone.check();
    expect(gone.speaker).toBe(21);
  });
});

describe("声を替える (PUT /api/speech)", () => {
  const put = (body: string, type = "application/json") =>
    new Request("http://s.test/api/speech", {
      method: "PUT",
      headers: { "content-type": type },
      body,
    });

  test("ログインした人なら替えられる。ログイン無し・JSON でない・選べない声は断る", async () => {
    const e = fakeEngine();
    const saved: [number, string][] = [];
    const v = new Voicevox({
      url: "http://vv:50021",
      fetch: e.f,
      now: () => NOW,
      store: { load: () => undefined, save: (id, by) => saved.push([id, by]) },
    });
    await v.check();
    const body = JSON.stringify({ voice: 52 });
    expect((await changeVoice(v, undefined, put(body))).status).toBe(401);
    // フォームの形式 (別のオリジンからプリフライトなしで送れる) は受けない
    expect(
      (await changeVoice(v, "sub-1", put(body, "text/plain"))).status,
    ).toBe(415);
    expect((await changeVoice(undefined, "sub-1", put(body))).status).toBe(404);
    expect((await changeVoice(v, "sub-1", put("{"))).status).toBe(400);
    expect(
      (await changeVoice(v, "sub-1", put(JSON.stringify({ voice: "52" }))))
        .status,
    ).toBe(400);
    expect(
      (await changeVoice(v, "sub-1", put(JSON.stringify({ voice: 13 }))))
        .status,
    ).toBe(400);
    expect(saved).toEqual([]);
    const ok = await changeVoice(v, "sub-1", put(body));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { voice: number }).voice).toBe(52);
    expect(saved).toEqual([[52, "sub-1"]]);
  });
});

describe("家の設定 (DB)", () => {
  test("声を DB に覚え、読み直せる。読めない値は無いものとする", () => {
    const d = openDb(":memory:");
    const s = voiceStore(d);
    expect(s.load()).toBeUndefined();
    s.save(52, "sub-1");
    expect(s.load()).toBe(52);
    s.save(3, "sub-2");
    expect(s.load()).toBe(3);
    expect(readSetting(d, "voice")).toBe(3);
    expect(
      d
        .query<{ updated_by: string }, []>(
          "SELECT updated_by FROM settings WHERE key = 'voice'",
        )
        .get()?.updated_by,
    ).toBe("sub-2");
    writeSetting(d, "voice", "52", "sub-1");
    expect(s.load()).toBeUndefined();
    d.run("UPDATE settings SET value = '{' WHERE key = 'voice'");
    expect(s.load()).toBeUndefined();
  });
});

describe("wavSeconds", () => {
  /** 24000 Hz・16 bit・モノラル (VOICEVOX の既定) の WAV。音は `samples` 個 */
  const wav = (samples: number, extra = new Uint8Array()) => {
    const data = samples * 2;
    const b = new Uint8Array(44 + extra.byteLength + data);
    const v = new DataView(b.buffer);
    const put = (at: number, s: string) =>
      b.set(new TextEncoder().encode(s), at);
    put(0, "RIFF");
    v.setUint32(4, b.byteLength - 8, true);
    put(8, "WAVE");
    put(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 24000, true);
    v.setUint32(28, 48000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    b.set(extra, 36);
    put(36 + extra.byteLength, "data");
    v.setUint32(40 + extra.byteLength, data, true);
    return b;
  };

  test("data の大きさと 1 秒あたりのバイト数から秒数を出す", () => {
    expect(wavSeconds(wav(24000))).toBe(1);
    expect(wavSeconds(wav(36000))).toBe(1.5);
  });

  test("fmt と data の間にほかのチャンクがあっても読む", () => {
    const list = new Uint8Array(12);
    list.set(new TextEncoder().encode("LIST"), 0);
    new DataView(list.buffer).setUint32(4, 4, true);
    expect(wavSeconds(wav(12000, list))).toBe(0.5);
  });

  test("WAV でなければ undefined", () => {
    expect(
      wavSeconds(new TextEncoder().encode("21:こんにちは")),
    ).toBeUndefined();
    expect(wavSeconds(new Uint8Array())).toBeUndefined();
  });
});
