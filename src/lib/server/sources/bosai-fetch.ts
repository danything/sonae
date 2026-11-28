/**
 * 気象庁ホームページ (bosai) の JSON を取る道具。予備の源 (`jma-bosai-weather`・`jma-bosai-eqvol`) が使う
 * (docs/design.md の 2.1 の「予備の源」)。
 *
 * - 一覧は条件付きで取る (`If-None-Match` と `If-Modified-Since`)。変わっていなければ 304 で本体を運ばない
 * - 控え (ETag・Last-Modified) を覚えるのは呼ぶ側が決める (`remember`)。採れなかった報があっても控えは覚え、
 *   読み直すときは手元の本文を使う (変わっていない一覧を取り直さない)
 * - 圧縮は fetch の既定 (`Accept-Encoding: gzip, deflate, br, zstd`) に任せる。警報の全国の一覧は 1.3MB あるが、
 *   運ぶのは圧縮した 48KB ほど (2026-11-28 に確かめた)
 * - 本体は開いた後で `MAX_BODY_BYTES` (8MB) までしか読まない (形が変わって大きくなっても、メモリを食い尽くさない)
 */

import { USER_AGENT } from "./retry.ts";

export interface BosaiValidators {
  etag?: string;
  modified?: string;
}

/** 取った本文と、次に条件を付けるための控え */
export interface BosaiBody {
  text: string;
  validators: BosaiValidators;
}

/** 200 でも 304 でもないとき。`status` を見て、取り直すか (5xx など) 諦めるか (404・410) を決める */
export class BosaiHttpError extends Error {
  constructor(
    url: string,
    readonly status: number,
  ) {
    super(`${url} が ${status} を返しました`);
  }
}

export class BosaiFetcher {
  private readonly validators = new Map<string, BosaiValidators>();

  constructor(
    private readonly doFetch: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  /** 取る。`conditional` なら覚えた控えを付け、304 なら undefined。200 でも 304 でもなければ `BosaiHttpError` */
  async get(
    url: string,
    signal: AbortSignal,
    conditional: boolean,
  ): Promise<BosaiBody | undefined> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    const v = conditional ? this.validators.get(url) : undefined;
    if (v?.etag) headers["if-none-match"] = v.etag;
    if (v?.modified) headers["if-modified-since"] = v.modified;
    const res = await this.doFetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (res.status === 304) {
      void res.body?.cancel();
      return undefined;
    }
    if (!res.ok) {
      void res.body?.cancel();
      throw new BosaiHttpError(url, res.status);
    }
    return {
      text: await readText(res, url),
      validators: {
        etag: res.headers.get("etag") ?? undefined,
        modified: res.headers.get("last-modified") ?? undefined,
      },
    };
  }

  /** 次からこの控えを付けて取る。控えが無い応答なら前の控えを捨てる (古い控えで 304 をもらい、変わった本文を読み損ねない) */
  remember(url: string, v: BosaiValidators): void {
    if (v.etag || v.modified) this.validators.set(url, v);
    else this.validators.delete(url);
  }

  /** 控えを捨てる (次は本体を取り直す) */
  forget(url: string): void {
    this.validators.delete(url);
  }
}

/** 取り直してよい失敗か (5xx・408・429・つながらない・時間切れ)。404・410 などは取り直しても取れない */
export function retryable(err: unknown): boolean {
  if (err instanceof BosaiHttpError)
    return err.status >= 500 || err.status === 408 || err.status === 429;
  return true;
}

/** 本体を読む上限 (開いた後の大きさ)。いちばん大きい警報の全国の一覧が 1.3MB */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 本体を上限まで読む。超えたら読むのをやめて例外 (取り直さない失敗) */
async function readText(res: Response, url: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      void reader.cancel();
      // 取り直しても同じなので、404 と同じく諦める側 (取り直さない失敗) にする
      const err = new BosaiHttpError(url, 413);
      err.message = `${url} の本体が ${MAX_BODY_BYTES / 1024 / 1024}MB を超えました`;
      throw err;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
