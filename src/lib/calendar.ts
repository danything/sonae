/** サイドバーの月のカレンダーの数え方。月は `YYYY-MM`、日は `YYYY-MM-DD` (どちらも日本時間) */

const pad = (n: number) => String(n).padStart(2, "0");

/** 月の升目。週は日曜から始め、月の外は null */
export function monthGrid(month: string): (string | null)[][] {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return [];
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** 「2026 年 11 月」 */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return y && m ? `${y} 年 ${m} 月` : "";
}

/** 行き来できる月 (並べてあるもの) の中で、`month` の前 (-1) か次 (+1)。無ければ null */
export function stepMonth(
  months: string[],
  month: string,
  step: -1 | 1,
): string | null {
  const found =
    step === 1
      ? months.find((m) => m > month)
      : months.toReversed().find((m) => m < month);
  return found ?? null;
}
