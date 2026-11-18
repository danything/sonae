/**
 * **信頼するネットワークの中なら、ログイン (OIDC) なしで通す** (docs/design.md の 2.6・docs/install.md の「ログイン」)。
 * 1 行で入れたセルフホストの 1 台目で、IdP を用意しなくても開けるようにするためのもの。denpa の `TRUSTED_NETWORKS` と同じ考え方。
 *
 * | 環境変数           | 中身                                                                                                  |
 * | ------------------ | ----------------------------------------------------------------------------------------------------- |
 * | `TRUSTED_NETWORKS` | ログインなしで通すネットワーク (CIDR のカンマ区切り)。**空なら誰も通さない** (いままでどおり OIDC だけ) |
 * | `TRUSTED_PROXIES`  | 前段 (リバースプロキシ) のアドレス。ここから来たときだけ `X-Forwarded-For` を読む                     |
 * | `ALLOWED_HOSTS`    | ログインなしで開いてよい名前 (カンマ区切り。`.example.com` でその下も)。IP・localhost・家の中の名前は書かなくてよい |
 *
 * - **通すのは、アドレスが `TRUSTED_NETWORKS` に当たり、かつ知っている名前で来たときだけ。** アドレスだけで通すと、
 *   DNS リバインディング (悪いサイトが自分の名前を LAN の sonae の IP に向け直す) で、LAN の人のブラウザから
 *   そのサイトの一部として読み書きされる。攻める側が自分の名前として用意できないもの (IP の直書き・localhost・
 *   ドットの無い名前・家の中だけの名前・`ALLOWED_HOSTS`) だけを通す
 * - **接続元は、直の相手が `TRUSTED_PROXIES` のときだけ `X-Forwarded-For` から読む** (`address.ts` の `resolveClient`)。
 *   誰でも付けられるヘッダなので、前段でない相手のものは読まない
 * - **adapter-bun の `ADDRESS_HEADER` を設定していたら、信頼するネットワークは使わない** (閉じる)。
 *   `getClientAddress()` がそのヘッダの値になり、誰でも名乗れるため
 * - 通した人は全員 1 つの利用者 (`TRUSTED_USER`) として扱う。通知の条件・Web Push の購読・Webhook は、この家の LAN の人で共有になる
 *   (読み上げの声は、ログインした人も含めて家で 1 つ)
 */

import {
  inAny,
  networks,
  normalize,
  resolveClient,
  unreadable,
} from "./address.ts";

/** 信頼するネットワークから来た人 (全員で 1 人) */
export const TRUSTED_USER = {
  subject: "trusted-network",
  name: "家のネットワーク",
} as const;

/** 家の中だけの名前 (攻める側が自分の名前として取れない) */
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".home.arpa",
  ".internal",
] as const;

export interface TrustConfig {
  networks: string[];
  proxies: string[];
  allowedHosts: string[];
  /** adapter-bun の `HOST_HEADER` (名前を読むヘッダ)。空なら Host だけ */
  hostHeader: string;
  /** adapter-bun の `ADDRESS_HEADER`。設定してあれば信頼するネットワークを使わない */
  addressHeader: string;
}

/** 環境変数は毎回読む (テストが差し替えられるように) */
export function trustConfig(
  env: Record<string, string | undefined> = process.env,
): TrustConfig {
  return {
    networks: networks(env.TRUSTED_NETWORKS ?? ""),
    proxies: networks(env.TRUSTED_PROXIES ?? ""),
    allowedHosts: networks(env.ALLOWED_HOSTS ?? "")
      .map((x) => x.toLowerCase().replace(/\.$/, ""))
      .filter((x) => x !== "" && x !== "."),
    hostHeader: (env.HOST_HEADER ?? "").trim().toLowerCase(),
    addressHeader: (env.ADDRESS_HEADER ?? "").trim(),
  };
}

/** 信頼するネットワークを使うか (書いてあり、`ADDRESS_HEADER` を設定していない) */
export const trustEnabled = (c: TrustConfig): boolean =>
  c.networks.length > 0 && c.addressHeader === "";

/** 起動のときに出す注意 (書き損じと、閉じた理由) */
export function trustWarnings(c: TrustConfig): string[] {
  const out: string[] = [];
  for (const e of unreadable(c.networks))
    out.push(`TRUSTED_NETWORKS の「${e}」は読めないので無視します`);
  for (const e of unreadable(c.proxies))
    out.push(`TRUSTED_PROXIES の「${e}」は読めないので無視します`);
  if (c.networks.length > 0 && c.addressHeader !== "")
    out.push(
      `ADDRESS_HEADER (${c.addressHeader}) を設定しているので、TRUSTED_NETWORKS は使いません (接続元を誰でも名乗れるため)。前段の後ろなら、ADDRESS_HEADER を消して TRUSTED_PROXIES に前段のアドレスを書いてください`,
    );
  return out;
}

/** ポートと `[]` を外し、小文字にして、最後のドットを落とす。空なら null */
function bareName(host: string): string | null {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    return end > 1 ? name.slice(1, end) : null;
  }
  const colon = name.indexOf(":");
  if (colon >= 0) name = name.slice(0, colon);
  name = name.replace(/\.$/, "");
  return name === "" ? null : name;
}

/** ログインなしで開いてよい名前か (`Host` の値。ポート付きでよい)。読めない形式なら通さない */
export function knownHost(host: string, allowed: readonly string[]): boolean {
  const name = bareName(host);
  if (name === null) return false;
  if (normalize(name) !== null) return true;
  if (!/^[a-z0-9_.-]+$/.test(name)) return false;
  if (name === "localhost" || !name.includes(".")) return true;
  if (LOCAL_SUFFIXES.some((s) => name.length > s.length && name.endsWith(s)))
    return true;
  return allowed.some((entry) =>
    entry.startsWith(".")
      ? name === entry.slice(1) || name.endsWith(entry)
      : name === entry,
  );
}

export type TrustResult =
  | { ok: true; address: string }
  | { ok: false; address: string; reason: "network" }
  | { ok: false; address: string; reason: "host"; host: string };

/**
 * 信頼するネットワークの中から、知っている名前で来たか。`peer` は直の相手 (`getClientAddress()`)。
 * 名前は `Host` と、`HOST_HEADER` を設定していればそのヘッダも見る (adapter が名前に使うほう。
 * `X-Forwarded-Host` のようなヘッダは同じオリジンのスクリプトからなら付けられるので、片方だけでは足りない)
 */
export function checkTrusted(
  peer: string,
  headers: Headers,
  c: TrustConfig,
): TrustResult {
  const address = resolveClient(
    peer,
    headers.get("x-forwarded-for"),
    c.proxies,
  );
  if (!trustEnabled(c) || !inAny(address, c.networks))
    return { ok: false, address, reason: "network" };
  const names = [headers.get("host")];
  if (c.hostHeader !== "" && c.hostHeader !== "host") {
    const forwarded = headers.get(c.hostHeader);
    if (forwarded !== null) names.push(forwarded);
  }
  const foreign = names.find(
    (name) => name === null || !knownHost(name, c.allowedHosts),
  );
  if (foreign !== undefined)
    return { ok: false, address, reason: "host", host: foreign ?? "" };
  return { ok: true, address };
}

/** 知らない名前で来たことを知らせた名前 (同じ名前で何度来ても 1 度だけ。覚えるのは上限まで) */
const reported = new Set<string>();

/**
 * **ほかのサイトから送らせた書き込みか** (信頼するネットワークで通した人だけに使う)。
 *
 * ログインなしで通すと、Cookie の SameSite の守りが効かない。LAN の人が悪いサイトを開くと、そのサイトが
 * `http://192.168.x.x:3030/api/...` へ送らせた要求も、接続元は LAN・名前は IP の直書きなので通ってしまう。
 * SvelteKit の CSRF の守りも、フォームで送れる形式 (`text/plain` も含む) と Content-Type の無い本文の書き込みを、
 * `Origin` が違えば断る。その判定 (本文の形式と `Origin` だけで決める) に任せず、ここでも、状態を変える要求 (GET・HEAD・OPTIONS 以外) は、ブラウザが付ける `Sec-Fetch-Site` (無ければ `Origin`) が同じオリジンでなければ断る。
 * どちらも無い (ブラウザでない道具) ときは通す (ほかのサイトから送らせることはできない)
 */
export function crossSiteWrite(request: Request, origin: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  // Sec-Fetch-Site はブラウザが付け、ページのスクリプトからは変えられないので、あればそれだけで決める
  // (前段が TLS を終えて `url.origin` が http になっていても、同じオリジンの書き込みを断らないように)。
  // Origin と比べるのは、Sec-Fetch-Site を付けない古いブラウザのときだけ
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin" && site !== "none";
  const from = request.headers.get("origin");
  return from !== null && from !== origin;
}

/** 信頼するネットワークの中から知らない名前で来たとき、ログに理由を 1 度だけ出す */
export function reportForeignHost(address: string, host: string): void {
  if (reported.has(host) || reported.size > 64) return;
  reported.add(host);
  if (reported.size > 64) {
    console.warn("[auth] 知らない名前が多いので、これより後は知らせません");
    return;
  }
  console.warn(
    `[auth] 信頼するネットワーク (${address}) から、知らない名前「${host || "(名前なし)"}」で来たので、ログインなしでは通しません。この名前で開くなら ALLOWED_HOSTS に足してください (docs/install.md)`,
  );
}
