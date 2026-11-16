import { describe, expect, test } from "bun:test";

import { openDb } from "#lib/server/db.ts";
import { noticeOf, payloadOf } from "#lib/server/notify.ts";
import { publicOrigin, publicUrlBroken } from "#lib/server/site.ts";
import {
  bodyOf,
  discord,
  DISCORD_CONTENT_LIMIT,
  failure,
  hostOf,
  MAX_WEBHOOKS,
  slack,
  textOf,
  Webhooks,
  webhookUrl,
} from "#lib/server/webhook.ts";
import { statusLabel } from "#lib/webhook.ts";

import { NOW, prefs, quake, tsunami } from "./events.ts";

const DISCORD = "https://discord.com/api/webhooks/123/secret-token";
const SLACK = "https://hooks.slack.com/services/T000/B000/secret";
const OTHER = "http://homeassistant.local:8123/api/webhook/secret-id";

function setup(status: (url: string) => number | Error = () => 204) {
  const db = openDb(":memory:");
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    const s = status(url);
    if (s instanceof Error) throw s;
    return new Response(null, { status: s });
  }) as unknown as typeof fetch;
  const hooks = new Webhooks(db, {
    fetch: fakeFetch,
    now: () => NOW,
    origin: "https://s.example",
  });
  return { db, hooks, calls };
}

describe("送り先の URL", () => {
  test("http・https でホストのあるものだけ受ける", () => {
    expect(webhookUrl(DISCORD)).toBe(true);
    expect(webhookUrl(OTHER)).toBe(true);
    expect(webhookUrl("ftp://example.com/x")).toBe(false);
    expect(webhookUrl("javascript:alert(1)")).toBe(false);
    expect(webhookUrl("not a url")).toBe(false);
    expect(webhookUrl(`https://example.com/${"a".repeat(2100)}`)).toBe(false);
  });

  test("画面と記録にはホストだけを出す (パス・クエリ・ユーザー情報は出さない)", () => {
    expect(hostOf(DISCORD)).toBe("discord.com");
    expect(hostOf("https://user:pass@example.com:8443/hook?key=s")).toBe(
      "example.com:8443",
    );
    expect(hostOf("::")).toBe("(読めない URL)");
  });

  test("Discord と Slack を見分ける", () => {
    expect(discord(DISCORD)).toBe(true);
    expect(discord("https://discordapp.com/api/v10/webhooks/1/t")).toBe(true);
    expect(discord("https://ptb.discord.com/api/webhooks/1/t")).toBe(true);
    // Slack 互換のエンドポイントは text を読むので Discord の形にしない
    expect(discord("https://discord.com/api/webhooks/1/t/slack")).toBe(false);
    expect(discord("https://discord.com.evil.example/api/webhooks/1/t")).toBe(
      false,
    );
    expect(slack(SLACK)).toBe(true);
    expect(slack(DISCORD)).toBe(false);
  });

  test("送れなかった理由に、例外の文 (URL が入りうる) を出さない", () => {
    expect(failure(new Error(`fetch failed: ${DISCORD}`))).toBe(
      "つながりませんでした",
    );
    expect(
      failure(Object.assign(new Error(DISCORD), { code: "ECONNREFUSED" })),
    ).toBe("つながりませんでした (ECONNREFUSED)");
    expect(failure(new DOMException("x", "TimeoutError"))).toBe("時間切れです");
    expect(failure(Object.assign(new Error("x"), { code: DISCORD }))).toBe(
      "つながりませんでした",
    );
  });

  test("PUBLIC_URL から押すと開く画面の origin を作る", () => {
    expect(publicOrigin({ PUBLIC_URL: "https://s.example/" })).toBe(
      "https://s.example",
    );
    expect(publicOrigin({})).toBeUndefined();
    expect(publicOrigin({ PUBLIC_URL: "nope" })).toBeUndefined();
    // 入っているのに読めないときだけ、起動したときに警告する
    expect(publicUrlBroken({ PUBLIC_URL: "nope" })).toBe(true);
    expect(publicUrlBroken({ PUBLIC_URL: "https://s.example" })).toBe(false);
    expect(publicUrlBroken({})).toBe(false);
  });

  test("直近の結果の文", () => {
    expect(statusLabel(null)).toBe("未送信");
    expect(statusLabel("ok")).toBe("成功");
    expect(statusLabel("404")).toBe("404");
  });
});

describe("送る本文", () => {
  const n = noticeOf(quake(), NOW);
  if (!n) throw new Error("通知が無い");
  const p = payloadOf(n, true);

  test("Web Push と同じ見出しと本文に、押すと開く画面の URL を添える", () => {
    expect(textOf(p, OTHER, "https://s.example")).toBe(
      `${p.title}\n${p.body}\nhttps://s.example${p.url}`,
    );
    // PUBLIC_URL が無ければ URL を付けない
    expect(textOf(p, OTHER, undefined)).toBe(`${p.title}\n${p.body}`);
  });

  test("Discord は content だけで、メンションを切り、リンクの見本を出さない", () => {
    const b = bodyOf(DISCORD, p, "https://s.example", NOW);
    expect(b).toEqual({
      content: `${p.title}\n${p.body}\n<https://s.example${p.url}>`,
      allowed_mentions: { parse: [] },
    });
    const long = bodyOf(
      DISCORD,
      { ...p, body: "あ".repeat(3000) },
      undefined,
      NOW,
    );
    expect(String(long.content)).toHaveLength(DISCORD_CONTENT_LIMIT);
    expect(String(long.content).endsWith("…")).toBe(true);
    // サロゲートペアの字 (𩸽) を途中で切らない
    const astral = bodyOf(
      DISCORD,
      { ...p, title: "", body: "𩸽".repeat(3000) },
      undefined,
      NOW,
    );
    const chars = Array.from(String(astral.content));
    expect(chars).toHaveLength(DISCORD_CONTENT_LIMIT);
    expect(chars.slice(0, -1).every((c) => c === "𩸽" || c === "\n")).toBe(
      true,
    );
  });

  test("Slack は text の & < > を逃がし、URL をリンクの形にする", () => {
    const b = bodyOf(
      SLACK,
      { ...p, title: "A & <B>", body: "c" },
      "https://s.example",
      NOW,
    );
    expect(b.text).toBe(`A &amp; &lt;B&gt;\nc\n<https://s.example${p.url}>`);
  });

  test("ほかの送り先には text と、機械が読む項目を送る", () => {
    const b = bodyOf(OTHER, p, "https://s.example", NOW);
    expect(b).toEqual({
      text: `${p.title}\n${p.body}\nhttps://s.example${p.url}`,
      title: p.title,
      body: p.body,
      tag: p.tag,
      url: `https://s.example${p.url}`,
      timestamp: new Date(p.timestamp).toISOString(),
      sentAt: new Date(NOW).toISOString(),
    });
  });
});

describe("送り手", () => {
  test("条件に合う Webhook にだけ送り、続報は同じ中身なら送らない", async () => {
    const { hooks, calls } = setup();
    hooks.add("me", DISCORD, prefs());
    // 住んでいる地域 (東京都２３区) で震度 3 以上のときだけ
    const tokyo = {
      code: "1310100",
      name: "東京都千代田区",
      quake: { code: "350", name: "東京都２３区" },
      office: "130000",
      ichiji: "130010",
    };
    hooks.add("me", OTHER, prefs({ quake: "nearby", home: tokyo }));
    const first = quake({
      areas: [{ code: "341", name: "千葉県北西部", int: "4" }],
    });

    expect(await hooks.handle(first)).toEqual(["ok"]);
    expect(calls.map((c) => c.url)).toEqual([DISCORD]);
    // 同じ中身の続報は送らない
    expect(await hooks.handle(first)).toEqual([]);
    // 震度 5 強に上がり、東京都２３区も震度 3 になったら、両方に送る
    expect(await hooks.handle(quake({ maxInt: "5+" }))).toEqual(["ok", "ok"]);
    expect(hooks.list("me").map((w) => w.lastStatus)).toEqual(["ok", "ok"]);
  });

  test("Web Push なら鳴らさずに置き換える続報 (震源が決まった・取消) も、新しい投稿として送る", async () => {
    const { hooks, calls } = setup();
    hooks.add("me", OTHER, prefs());
    expect(await hooks.handle(quake())).toEqual(["ok"]);
    // M が決まった続報 (重さは同じ)
    expect(await hooks.handle(quake({ magnitude: 5.3 }))).toEqual(["ok"]);
    expect(await hooks.handle(quake({ cancelled: true }))).toEqual(["ok"]);
    expect(calls.map((c) => c.body.title)).toEqual([
      "最大震度4 千葉県北西部",
      "最大震度4 千葉県北西部",
      "地震情報 (取消)",
    ]);
    expect(calls[1]?.body.body).toContain("M5.3");
  });

  test("解除は、前に送った Webhook にだけ送る", async () => {
    const { hooks, calls } = setup();
    hooks.add("me", DISCORD, prefs());
    expect(await hooks.handle(tsunami())).toEqual(["ok"]);
    // 津波注意報を送った後に足した Webhook には、解除を送らない
    hooks.add("me", OTHER, prefs());
    expect(await hooks.handle(tsunami({ ended: true }))).toEqual(["ok"]);
    expect(calls.map((c) => c.url)).toEqual([DISCORD, DISCORD]);
  });

  test("404・410 が返っても Webhook を消さず、直近の結果に残す", async () => {
    for (const status of [404, 410]) {
      const { hooks } = setup(() => status);
      hooks.add("me", OTHER, prefs());
      expect(await hooks.handle(quake())).toEqual([String(status)]);
      expect(hooks.list("me").map((w) => w.lastStatus)).toEqual([
        String(status),
      ]);
    }
  });

  test("送れなかったら理由を残し、控えを消して次の続報で送り直す", async () => {
    let status: number | Error = 500;
    const { db, hooks } = setup(() => status);
    hooks.add("me", OTHER, prefs());
    expect(await hooks.handle(quake())).toEqual(["500"]);
    expect(hooks.list("me")[0]?.lastStatus).toBe("500");
    expect(db.query("SELECT COUNT(*) AS n FROM webhook_log").get()).toEqual({
      n: 0,
    });
    status = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    expect(await hooks.handle(quake())).toEqual([
      "つながりませんでした (ECONNREFUSED)",
    ]);
    status = 204;
    expect(await hooks.handle(quake())).toEqual(["ok"]);
  });

  test("リダイレクトは追わない", async () => {
    const { hooks } = setup(() => 302);
    hooks.add("me", OTHER, prefs());
    expect(await hooks.handle(quake())).toEqual([
      "302 (リダイレクトは追いません)",
    ]);
  });

  test(`登録は 1 人 ${MAX_WEBHOOKS} まで。条件の変更と解除は自分のものだけ`, () => {
    const { hooks } = setup();
    for (let i = 0; i < MAX_WEBHOOKS; i++)
      expect(hooks.add("me", `${OTHER}/${i}`, prefs())).toBeNumber();
    expect(hooks.add("me", OTHER, prefs())).toBe("full");
    expect(hooks.add("you", OTHER, prefs())).toBeNumber();

    expect(hooks.setPrefs("me", prefs({ eew: "off" }))).toBe(MAX_WEBHOOKS);
    expect(hooks.list("me").every((w) => w.prefs.eew === "off")).toBe(true);
    expect(hooks.list("you")[0]?.prefs.eew).toBe("everywhere");

    const first = hooks.list("me")[0]?.id ?? -1;
    expect(hooks.remove("you", first)).toBe(false);
    expect(hooks.remove("me", first)).toBe(true);
    expect(hooks.list("me")).toHaveLength(MAX_WEBHOOKS - 1);
  });

  test("消した Webhook の控えも消える", async () => {
    const { db, hooks } = setup();
    const id = hooks.add("me", OTHER, prefs());
    if (id === "full") throw new Error("足せない");
    await hooks.handle(quake());
    hooks.remove("me", id);
    expect(db.query("SELECT COUNT(*) AS n FROM webhook_log").get()).toEqual({
      n: 0,
    });
  });
});
