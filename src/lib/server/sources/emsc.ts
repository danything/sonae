/**
 * EMSC (欧州地中海地震センター) の Seismic Portal の WebSocket (`wss://www.seismicportal.eu/standing_order/websocket`)。
 * 世界の地震を、決まったときから流してくる (USGS のフィードより速いことが多い)。
 *
 * - 全部の規模が流れてくるので、M4.5 以上 (USGS のフィードと同じ) だけを受ける
 * - 地震ごとに「unid と更新の時刻」を鍵にする (続報で直ったら、もう一度受ける)
 * - 張り直しは 5 秒から倍々、上限 2 分 (半分までの揺らぎつき)。10 分何も来なければ切れたとみなして張り直す
 * - USGS と同じ地震は、時刻・位置・M の近さで 1 つにまとめる (store.ts の applyForeign)
 *
 * 仕様: https://www.seismicportal.eu/realtime.html 。CC BY 4.0、出典「Credit: EMSC-CSEM SeismicPortal」
 * (https://www.seismicportal.eu/terms.html)。サービスや DB の丸ごと・大部分を配り直すには書面の許可が要るので、
 * 広く公開するときは問い合わせる (docs/design.md の 1 章)。
 */

import type { ForeignReport } from "#lib/model.ts";

import { Backoff, type Connect, runSocket, StatusTracker } from "./retry.ts";
import type { Incoming, Source, SourceContext } from "./types.ts";

export const EMSC_WS = "wss://www.seismicportal.eu/standing_order/websocket";
/** 受ける M の下限 (USGS の 4.5_hour と同じ) */
export const EMSC_MIN_MAGNITUDE = 4.5;

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * 1 通を読む。M が下限より小さいもの・地震でないもの・読めないものは null。
 * JSON でなければ例外 (その 1 通を捨てる)
 */
export function parseEmsc(text: string): Incoming | null {
  const msg = JSON.parse(text) as Record<string, unknown>;
  if (msg.action !== "create" && msg.action !== "update") return null;
  const data = (msg.data ?? {}) as Record<string, unknown>;
  const p = (data.properties ?? {}) as Record<string, unknown>;
  const unid = str(p.unid) ?? str(data.id);
  const time = str(p.time);
  const lat = num(p.lat);
  const lon = num(p.lon);
  const mag = num(p.mag);
  if (!unid || !time || lat === undefined || lon === undefined) return null;
  if (!Number.isFinite(Date.parse(time))) return null;
  // ke は地震 (known earthquake)。爆破 (km・kx) などは採らない。印が無ければ地震とみなす
  const evtype = str(p.evtype);
  if (evtype && !evtype.startsWith("ke") && evtype !== "se") return null;
  if (mag === undefined || mag < EMSC_MIN_MAGNITUDE) return null;
  const depth = num(p.depth);
  const updated = str(p.lastupdate);
  const report: ForeignReport = {
    source: "emsc",
    sourceId: unid,
    url: /^[0-9A-Za-z_]+$/.test(unid)
      ? `https://www.seismicportal.eu/eventdetails.html?unid=${unid}`
      : undefined,
    originTime: new Date(time).toISOString(),
    lat,
    lon,
    depthKm: depth === undefined ? undefined : Math.abs(depth),
    magnitude: mag,
    magType: str(p.magtype),
    // 地域の名前は Flinn-Engdahl の地域名 (大文字。「NEW IRELAND REGION, P.N.G.」) のまま
    place: str(p.flynn_region) ?? "",
    updatedAt:
      updated && Number.isFinite(Date.parse(updated))
        ? new Date(updated).toISOString()
        : undefined,
  };
  return {
    source: "emsc",
    key: `${unid}@${report.updatedAt ?? report.originTime}`,
    code: "websocket",
    body: text,
    items: [{ type: "foreign", report }],
  };
}

export interface EmscOptions {
  url?: string;
  connect?: Connect;
  backoff?: Backoff;
  log?: (m: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function emscSource(ctx: SourceContext, opts: EmscOptions = {}): Source {
  const status = new StatusTracker("emsc", ctx.onStatus);
  const log = opts.log ?? ((m: string) => console.log(m));
  return {
    id: "emsc",
    status: () => status.get(),
    async run(signal) {
      await runSocket({
        url: opts.url ?? EMSC_WS,
        signal,
        status,
        connect: opts.connect,
        // 揺らぎは半分まで (すぐに張り直さないよう、いつも 2.5 秒以上は空ける)
        backoff:
          opts.backoff ??
          new Backoff(5_000, 120_000, () => 0.5 + Math.random() / 2),
        idleMs: 10 * 60_000,
        sleep: opts.sleep,
        log: opts.log,
        onMessage(text) {
          status.seen(false);
          let m: Incoming | null;
          try {
            m = parseEmsc(text);
          } catch (err) {
            log(`[emsc] 読めない 1 通を捨てました: ${err}`);
            return;
          }
          if (!m || ctx.seen("emsc", m.key)) return;
          status.seen(true);
          ctx.emit(m);
        },
      });
    },
  };
}
