/**
 * 作り直した火山の表 (活火山の位置・火山の監視カメラ) と、main にあるものを比べ、変わった項目を Markdown で出す。
 * `.github/workflows/map-data.yml` が PR の本文と、自分でマージしてよいかの判定に使う (docs/map.md の「表を作り直す」)。
 *
 *   bun tools/map-data/diff.ts <前の volcano-points.json> <前の volcano-cameras.json>
 *
 * 標準出力に本文を、最後の行に `changes=<数>` を出す。数は、足された・消えた・名前か位置が変わった項目の合計。
 * ファイルは変わったのに数が 0 (約 100 m 未満の位置の違い・出力の形の違い) なら、workflow は自分でマージしない
 */
type Points = Record<string, [number, number, string?]>;
interface Cameras {
  features: {
    properties: { vc: string; volcano: string; camera: string };
    geometry: { coordinates: [number, number] };
  }[];
}

const [oldPointsPath, oldCamerasPath] = process.argv.slice(2);
if (!oldPointsPath || !oldCamerasPath)
  throw new Error("前の表の 2 つのパスを渡してください");
const read = async <T>(path: string): Promise<T> => Bun.file(path).json();

/** 位置は小数 3 桁 (約 100 m) より細かい違いを見ない */
const near = (a: number[], b: number[]) =>
  a.length >= 2 &&
  b.length >= 2 &&
  Math.abs((a[0] ?? 0) - (b[0] ?? 0)) < 0.0005 &&
  Math.abs((a[1] ?? 0) - (b[1] ?? 0)) < 0.0005;

function compare<T>(
  title: string,
  before: Map<string, T>,
  after: Map<string, T>,
  name: (v: T) => string,
  where: (v: T) => number[],
): string[] {
  const lines: string[] = [];
  for (const [k, v] of after)
    if (!before.has(k)) lines.push(`- 足された: ${k} ${name(v)}`);
  for (const [k, v] of before)
    if (!after.has(k)) lines.push(`- 消えた: ${k} ${name(v)}`);
  for (const [k, v] of after) {
    const old = before.get(k);
    if (old === undefined) continue;
    if (name(old) !== name(v))
      lines.push(`- 名前が変わった: ${k} ${name(old)} → ${name(v)}`);
    else if (!near(where(old), where(v)))
      lines.push(
        `- 位置が変わった: ${k} ${name(v)} (${where(old).join(", ")} → ${where(v).join(", ")})`,
      );
  }
  return lines.length > 0
    ? [`### ${title} (${before.size} → ${after.size})`, "", ...lines, ""]
    : [];
}

const pointsMap = (p: Points) => new Map(Object.entries(p));
/** カメラの番号が欠けたり重なったりしていたら止める (1 つにまとまると、変わった数を少なく数え、自動のマージを誤らせる) */
function camerasMap(c: Cameras) {
  const m = new Map<string, Cameras["features"][number]>();
  for (const f of c.features) {
    const vc = f.properties?.vc;
    if (!vc) throw new Error(`番号の無いカメラ: ${JSON.stringify(f)}`);
    if (m.has(vc)) throw new Error(`同じ番号のカメラが 2 つある: ${vc}`);
    m.set(vc, f);
  }
  return m;
}

const points = compare(
  "活火山の位置 (static/areas/volcano-points.json)",
  pointsMap(await read<Points>(oldPointsPath)),
  pointsMap(await read<Points>("static/areas/volcano-points.json")),
  (v) => v[2] ?? "",
  (v) => [v[0], v[1]],
);
const cameras = compare(
  "火山の監視カメラ (static/cameras/volcano-cameras.json)",
  camerasMap(await read<Cameras>(oldCamerasPath)),
  camerasMap(await read<Cameras>("static/cameras/volcano-cameras.json")),
  (f) => `${f.properties.volcano} ${f.properties.camera}`,
  (f) => f.geometry.coordinates,
);
const lines = [...points, ...cameras];
console.log(lines.join("\n"));
console.log(`changes=${lines.filter((l) => l.startsWith("- ")).length}`);
