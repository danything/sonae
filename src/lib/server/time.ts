/**
 * P2P地震情報と Wolfx の時刻 (`2006/01/02 15:04:05.999`、日本時間) を ISO 8601 (+09:00) にする。
 * 形が違えば undefined。
 */
export function jstToIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m =
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(
      value.trim(),
    );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = "00", frac = ""] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac}+09:00`;
}

/** ISO 8601 の時刻をミリ秒に。読めなければ NaN */
export const ms = (iso: string | undefined) =>
  iso === undefined ? Number.NaN : Date.parse(iso);

export const nowIso = () => new Date().toISOString();
