/**
 * VOICEVOX が読み違える地名の読み (ユーザー辞書。docs/design.md の 2.4)。
 *
 * 気象庁のコード表の震央地名 (343)・地震情報の細分区域 (194)・津波予報区 (70)・活火山 (111) を
 * エンジン 0.26.1 の `accent_phrases` に通し、出てきたカナを見て読み違えたものだけを足した
 * (2026-11-14)。足した後に同じ地名をもう一度通して、ここの読みになることを確かめている。
 * `accent` はアクセントの核の位置 (0 は平板)。エンジンに入れ直すときは `syncDictionary` が足りない語だけを足す。
 */

export interface Reading {
  surface: string;
  /** カタカナ */
  pronunciation: string;
  accent: number;
}

export const READINGS: readonly Reading[] = [
  // 北海道
  { surface: "渡島", pronunciation: "オシマ", accent: 0 },
  { surface: "渡島大島", pronunciation: "オシマオオシマ", accent: 4 },
  { surface: "後志", pronunciation: "シリベシ", accent: 0 },
  { surface: "苫小牧", pronunciation: "トマコマイ", accent: 3 },
  { surface: "苫小牧沖", pronunciation: "トマコマイオキ", accent: 0 },
  { surface: "恵庭岳", pronunciation: "エニワダケ", accent: 3 },
  { surface: "樽前山", pronunciation: "タルマエサン", accent: 0 },
  { surface: "茂世路岳", pronunciation: "モヨロダケ", accent: 3 },
  { surface: "小田萌山", pronunciation: "オダモイヤマ", accent: 4 },
  { surface: "指臼岳", pronunciation: "サシウスダケ", accent: 4 },
  { surface: "択捉阿登佐岳", pronunciation: "エトロフアトサヌプリ", accent: 0 },
  { surface: "天頂山", pronunciation: "テンチョウザン", accent: 3 },
  // 東北・関東
  { surface: "三八上北", pronunciation: "サンパチカミキタ", accent: 0 },
  { surface: "西方沖", pronunciation: "セイホウオキ", accent: 0 },
  { surface: "最上", pronunciation: "モガミ", accent: 0 },
  { surface: "岩手山", pronunciation: "イワテサン", accent: 0 },
  { surface: "赤城山", pronunciation: "アカギサン", accent: 0 },
  { surface: "高原山", pronunciation: "タカハラヤマ", accent: 4 },
  { surface: "内房", pronunciation: "ウチボウ", accent: 0 },
  // 中部
  { surface: "上越", pronunciation: "ジョウエツ", accent: 0 },
  { surface: "中越", pronunciation: "チュウエツ", accent: 0 },
  { surface: "下越", pronunciation: "カエツ", accent: 0 },
  { surface: "上中越", pronunciation: "ジョウチュウエツ", accent: 0 },
  { surface: "上中下越", pronunciation: "ジョウチュウカエツ", accent: 0 },
  { surface: "佐渡", pronunciation: "サド", accent: 1 },
  { surface: "外海", pronunciation: "ソトウミ", accent: 0 },
  // 九州・沖縄
  { surface: "平野部", pronunciation: "ヘイヤブ", accent: 0 },
  { surface: "山沿い", pronunciation: "ヤマゾイ", accent: 0 },
  { surface: "五島", pronunciation: "ゴトウ", accent: 0 },
  { surface: "鶴見岳", pronunciation: "ツルミダケ", accent: 3 },
  { surface: "若尊", pronunciation: "ワカミコ", accent: 0 },
  { surface: "与那国島", pronunciation: "ヨナグニジマ", accent: 4 },
  { surface: "久米島", pronunciation: "クメジマ", accent: 2 },
  { surface: "宮古島", pronunciation: "ミヤコジマ", accent: 3 },
  { surface: "石垣島", pronunciation: "イシガキジマ", accent: 4 },
  { surface: "西表島", pronunciation: "イリオモテジマ", accent: 5 },
  // 海の火山
  { surface: "海徳海山", pronunciation: "カイトクカイザン", accent: 5 },
  { surface: "北福徳堆", pronunciation: "キタフクトクタイ", accent: 0 },
  { surface: "福徳岡ノ場", pronunciation: "フクトクオカノバ", accent: 0 },
  { surface: "海形海山", pronunciation: "カイカタカイザン", accent: 5 },
  { surface: "南日吉海山", pronunciation: "ミナミヒヨシカイザン", accent: 7 },
  { surface: "日光海山", pronunciation: "ニッコウカイザン", accent: 5 },
  // 海外 (遠地地震)
  { surface: "遠地", pronunciation: "エンチ", accent: 1 },
];
