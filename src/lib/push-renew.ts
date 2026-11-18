/**
 * VAPID の鍵を替えたときの、購読の作り直し (docs/push.md の「鍵を替えるとき」)。
 * 前の鍵で作った購読には、配信サービスが 401・403 を返して送れない。そこで「通知」の窓を開いたとき
 * (`#lib/push-client.ts` の `readPushState`) に、このブラウザの購読の公開鍵 (`applicationServerKey`) と
 * サーバーの公開鍵を比べ、違えば購読を消して作り直し、サーバーに登録し直す。
 * DOM に頼らず、要るもの (pushManager・fetch) を受け取るので、試験から呼べる
 */

import { endpointBlock, type PushBlock } from "./push-support.ts";
import { base64UrlToBytes, type PushPrefs } from "./push.ts";

/** 購読の公開鍵が、サーバーの公開鍵と同じか (鍵を持たない購読は違うとみなす) */
export function sameKey(
  have: ArrayBuffer | null | undefined,
  want: Uint8Array,
): boolean {
  if (!have) return false;
  const a = new Uint8Array(have);
  return a.length === want.length && a.every((b, i) => b === want[i]);
}

/** 作り直すのに要るもの (ブラウザでは `navigator.serviceWorker.ready` の pushManager と `fetch`) */
export interface RenewDeps {
  pm: Pick<PushManager, "subscribe">;
  fetch: typeof fetch;
  /** サーバーに登録するときの名前 (ブラウザの UA) */
  label: string;
}

export type RenewResult =
  /** 鍵が同じなので、何もしていない */
  | { kind: "same" }
  /** 前の購読を消して作り直し、サーバーに登録し直した */
  | { kind: "renewed"; endpoint: string }
  /** 前の購読はサーバーに無かったので、消しただけ (登録は「このブラウザで受ける」で作る) */
  | { kind: "dropped" }
  /** 作り直した購読が届かない宛先だった (Android の Edge など)。購読は消してある */
  | { kind: "blocked"; block: PushBlock }
  /**
   * 作り直せなかった。理由を添える。`kept` は、サーバーの前の購読を消せず、何も変えずに残したとき
   * (次に「通知」を開いたときに作り直す)。そうでなければ前の購読は消してある
   */
  | { kind: "failed"; reason: string; kept: boolean };

/** 作り直せなかったときに「通知」の窓に出す文 */
export const renewFailedText = (reason: string, kept: boolean): string =>
  `サーバーの鍵が替わったため購読を作り直そうとしましたが、できませんでした (${reason})。${
    kept
      ? "次に「通知」を開いたときに、もう一度作り直します"
      : "「このブラウザで受ける」を押してください"
  }`;

/**
 * 購読の公開鍵がサーバーの公開鍵と違えば、作り直す。
 *
 * - 鍵が同じなら何もしない
 * - 違えば (前の鍵の購読には送れない)、サーバーの前の endpoint を消し、ブラウザの前の購読も消してから、
 *   新しい鍵で作り直した購読を、前と同じ条件 (`prefs`) で登録し直す。
 *   消すのを先にするのは、登録できるブラウザの数の上限に前の購読が数えられて、登録を断られないようにするため。
 *   サーバーの前の endpoint を消せなければ、何も変えずに返す (次に開いたときに作り直す)
 * - サーバーに前の endpoint が無ければ (`prefs` が null。ほかのブラウザから解除したときなど)、作り直さない。
 *   解除したブラウザに、また届くようにしないため
 */
export async function renewIfKeyChanged(
  cur: Pick<PushSubscription, "endpoint" | "options" | "unsubscribe">,
  publicKey: string,
  prefs: PushPrefs | null,
  deps: RenewDeps,
): Promise<RenewResult> {
  const want = base64UrlToBytes(publicKey);
  if (sameKey(cur.options.applicationServerKey, want)) return { kind: "same" };
  if (prefs === null) {
    await cur.unsubscribe().catch(() => false);
    return { kind: "dropped" };
  }
  // サーバーの前の購読を先に消す。消せなければ、ブラウザの購読も残して次に開いたときに作り直す
  // (ブラウザだけ消すと、サーバーに送れない購読が残り、上限の数に数えられ続ける)
  try {
    const del = await deps.fetch("/api/push", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: cur.endpoint }),
    });
    if (!del.ok)
      return {
        kind: "failed",
        reason: `前の購読を消せませんでした (${del.status})`,
        kept: true,
      };
  } catch (err) {
    return { kind: "failed", reason: errorName(err), kept: true };
  }
  await cur.unsubscribe().catch(() => false);
  try {
    const sub = await deps.pm.subscribe({
      userVisibleOnly: true,
      applicationServerKey: want,
    });
    const block = endpointBlock(sub.endpoint);
    if (block) {
      await sub.unsubscribe().catch(() => false);
      return { kind: "blocked", block };
    }
    const put = await deps.fetch("/api/push", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        prefs,
        label: deps.label,
      }),
    });
    if (!put.ok) {
      await sub.unsubscribe().catch(() => false);
      return {
        kind: "failed",
        reason: `登録できませんでした (${put.status})`,
        kept: false,
      };
    }
    return { kind: "renewed", endpoint: sub.endpoint };
  } catch (err) {
    return { kind: "failed", reason: errorName(err), kept: false };
  }
}

const errorName = (err: unknown): string =>
  err instanceof Error ? err.name : String(err);
