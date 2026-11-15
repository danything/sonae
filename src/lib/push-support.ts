/**
 * このブラウザで Web Push を使えるかの見分けと、使えないときに「通知」の窓に出す文 (docs/push.md の「使えないブラウザ」)。
 * DOM には触らない (見るものは呼ぶ側が渡す)。決めるのはできるだけ機能の有無と、ブラウザが返した購読の宛先で、
 * ブラウザの名前は文に添える一言にだけ使う。
 */

import { pushEndpointOk } from "./push.ts";

/** ブラウザにある機能 */
export interface PushFeatures {
  /** navigator.serviceWorker */
  serviceWorker: boolean;
  /** window.PushManager */
  pushManager: boolean;
  /** window.Notification */
  notification: boolean;
  /**
   * iPhone・iPad の Safari だけにある navigator.standalone (ホーム画面から開いたか)。無ければ undefined。
   * iOS は、ホーム画面に追加した Web アプリでだけ Web Push を使える
   */
  standalone: boolean | undefined;
}

/** Web Push を使えない訳 */
export type PushBlock =
  /** iPhone・iPad で、ホーム画面に追加せずに開いている */
  | { kind: "ios" }
  /** 要る機能が無い */
  | { kind: "missing"; missing: string[] }
  /** 登録はできたが、ブラウザが届かない宛先 (知らない配信サービス・`.invalid` など) を返した */
  | { kind: "endpoint"; host: string };

/** 機能の有無から、Web Push を使えない訳 (使えそうなら null。宛先は登録してみるまで分からない) */
export function pushBlockOf(f: PushFeatures): PushBlock | null {
  const missing = [
    f.serviceWorker ? "" : "Service Worker",
    f.pushManager ? "" : "Push API",
    f.notification ? "" : "Notification API",
  ].filter((s) => s !== "");
  if (missing.length === 0) return null;
  if (f.standalone === false) return { kind: "ios" };
  return { kind: "missing", missing };
}

/** 登録で返った宛先が届かないものなら、その訳 (届くなら null) */
export function endpointBlock(endpoint: string): PushBlock | null {
  if (pushEndpointOk(endpoint)) return null;
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    // URL でない宛先
  }
  return { kind: "endpoint", host: host || "宛先なし" };
}

/** Android の Edge か (文に添える一言のためだけ。判断には使わない) */
export const isAndroidEdge = (userAgent: string): boolean =>
  /\bAndroid\b/.test(userAgent) && /\bEdgA\//.test(userAgent);

/** 代わりの道。開いている間の通知・音・読み上げは、Web Push が無くても使える */
const OPEN_NOTE =
  "sonae を開いている間は、上の「開いているとき」の通知・音・読み上げで知らせます。";

/** 使えない訳を、何ができないかと代わりの道で言う文 */
export function pushBlockText(block: PushBlock, userAgent: string): string {
  if (block.kind === "ios")
    return `iPhone・iPad では、ホーム画面に追加した sonae (iOS 16.4 以降) でだけ Web Push を受けられます。Safari の共有ボタンから「ホーム画面に追加」して、そこから開いてください。${OPEN_NOTE}`;
  const edge = isAndroidEdge(userAgent);
  const name = edge ? "このブラウザ (Android の Edge) " : "このブラウザ";
  const instead = edge
    ? "タブを閉じていても届けるには、Android の Chrome で sonae を開いてください (アプリとして入れるときも Chrome から)。"
    : "タブを閉じていても届けるには、Chrome・Firefox・Safari・パソコンの Edge で sonae を開いてください。";
  if (block.kind === "missing")
    return `${name}は Web Push に対応していません (${block.missing.join("・")} がありません)。${instead}${OPEN_NOTE}`;
  return `${name}は Web Push の登録はできても、届かない宛先 (${block.host}) を返しました。Web Push は使えません。${instead}${OPEN_NOTE}`;
}

/**
 * 登録 (許可・subscribe・送信) が例外で止まったときの文。ブラウザが配信サービスにつながらないときも
 * ここに来る (Android の Edge の古い版や、配信サービスの無い Chromium)。訳と、代わりの道を言う
 */
export const registerFailedText = (err: unknown): string =>
  `登録できませんでした (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})。このブラウザの配信サービスにつながらないことがあります。ほかのブラウザ (Chrome・Firefox・Safari) で試してください。${OPEN_NOTE}`;

/** 許可を聞いてから、これより早く「拒否」が返ったら、ブラウザが窓を出さずに断ったとみなす (人が押せる速さではない) */
export const QUIET_DENY_MS = 400;

/**
 * 通知の許可が無いときの文。ブラウザが許可の窓を出さずに断ることがある
 * (前に閉じた・拒否した、Edge の「通知の要求を静かにする」、Android の Edge など)。
 * そのときは、何が起きたかと、サイトの設定で許す道筋を出す
 */
export function permissionDeniedText(
  userAgent: string,
  opts: { quiet?: boolean; asked?: boolean } = {},
): string {
  const how = isAndroidEdge(userAgent)
    ? "アドレスバーの鍵の印か、Edge の「…」→「設定」→「サイトのアクセス許可」→「通知」で、このサイトがブロックされていないか (前に窓を閉じたり拒否したりすると覚えている) と、Android の設定の「アプリ」→「Microsoft Edge」→「通知」が許可されているかを確かめてから、もう一度押してください。"
    : /\bEdg\//.test(userAgent)
      ? "アドレスバーの鍵の印 → 「このサイトのアクセス許可」→「通知」を「許可」にしてから、もう一度押してください。Edge の設定の「通知の要求を静かにする」がオンだと、窓の代わりにアドレスバーにベルの印が出るだけのことがあります。"
      : "アドレスバーの鍵の印 (サイトの設定) で、このサイトの通知を「許可」にしてから、もう一度押してください。";
  const what =
    opts.asked && opts.quiet
      ? "ブラウザが許可の窓を出さずに、通知を断りました (前に閉じたり拒否したりしたサイトや、ブラウザの設定で、窓が出ないことがあります)。"
      : "通知が許可されていません。";
  return `${what}${how}`;
}
