/**
 * どの画面にも出す注意文と出典 (docs/design.md の「法と表示」)。文言を変えるときは設計書も直す
 */
export const NOTICE =
  "このアプリは気象庁の公式のものではありません。情報は遅れたり欠けたりすることがあります。身の安全に関わる判断は、気象庁・自治体・テレビやラジオの公式の情報を優先してください。";

/** 緊急地震速報の画面に足す注意文。どちらの情報源も非公式で無保証 */
export const EEW_NOTICE =
  "緊急地震速報は、Wolfx Project と P2P地震情報 が中継したものを表示しています。どちらも気象庁の公式の配信ではなく、無保証です。遅れたり届かなかったりすることがあります。予想される震度は表示しません。";

/** 出典の文の 1 片。URL を持つ片は、窓でその URL へのリンクにする (字はそのまま出す) */
export type CreditPart = string | { text: string; href: string };

/** 出典の 1 項目: 何の出典か (見出し) と、規約の例のとおりの文 */
export interface Credit {
  label: string;
  parts: CreditPart[];
}

const JMA_FEED = "https://xml.kishou.go.jp/xmlpull.html";
const JMA_GIS = "https://www.data.jma.go.jp/developer/gis.html";
const GSI_TILES = "https://maps.gsi.go.jp/development/ichiran.html";
const GSI_SHELTERS = "https://www.gsi.go.jp/bousaichiri/hinanbasho.html";
const GSI_AFM = "https://www.gsi.go.jp/bousaichiri/active_fault.html";
const GSI_VECTOR = "https://github.com/gsi-cyberjapan/optimal_bvmap";
const GSI_MAPS = "https://maps.gsi.go.jp/";
const CSIS_GEOCODE = "https://geocode.csis.u-tokyo.ac.jp/";
const PB2002 = "https://github.com/fraxen/tectonicplates";
const ODC_BY = "https://opendatacommons.org/licenses/by/1-0/";
const DISAPORTAL =
  "https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html";

/**
 * 出典。「出典と注意」の窓にいつも全部出す。文は各機関の規約の例に合わせる (docs/design.md の 5 章):
 * 気象庁は「出典：気象庁ホームページ（URL）」と「気象庁「名称」（URL）を加工して作成」、国土地理院は
 * 「国土地理院」または「地理院タイル」と地理院タイル一覧へのリンク・加工したものは「地理院タイルに○○を追記して掲載」、
 * ハザードマップポータルサイトは「出典：「ハザードマップポータルサイト」」と「「ハザードマップポータルサイト」を加工して作成」
 */
export const CREDITS: Credit[] = [
  {
    label: "地震・津波・火山・気象の情報",
    parts: [
      "出典：気象庁ホームページ（",
      { text: JMA_FEED, href: JMA_FEED },
      "）。気象庁「防災情報XML」を加工して作成。編集の責任は sonae の運営者にあります。sonae は気象庁の発表を中継するだけで、予報や警報を自分で出しません",
    ],
  },
  {
    label: "区域の面と境界",
    parts: [
      "気象庁「予報区等GISデータ」（",
      { text: JMA_GIS, href: JMA_GIS },
      "）を加工して作成",
    ],
  },
  {
    label: "火山の位置・国際津波関連情報",
    parts: [
      "気象庁「活火山の一覧」（",
      {
        text: "https://www.jma.go.jp/bosai/volcano/",
        href: "https://www.jma.go.jp/bosai/volcano/",
      },
      "）・気象庁「北西太平洋津波情報」（",
      {
        text: "https://www.jma.go.jp/bosai/",
        href: "https://www.jma.go.jp/bosai/",
      },
      "）を加工して作成",
    ],
  },
  {
    label: "地図",
    parts: [
      "出典：国土地理院（",
      { text: "地理院タイル", href: GSI_TILES },
      "・",
      { text: "国土地理院最適化ベクトルタイル", href: GSI_VECTOR },
      "）。地理院タイルに震度・警報等の区域・避難場所・ハザード情報等を追記して掲載。国土地理院最適化ベクトルタイルを加工して作成",
    ],
  },
  {
    label: "写真",
    parts: [
      "地理院タイル「写真」(シームレス空中写真。国土地理院)・Landsat8画像（GSI, TSIC, GEO Grid/AIST）・Landsat8画像（courtesy of the U.S. Geological Survey）・海底地形（GEBCO）・世界衛星モザイク画像（NASA LP DAAC, USGS/EROS Center）・GRUS画像（© Axelspace）",
    ],
  },
  {
    label: "活断層",
    parts: [
      "地理院タイル「活断層図（都市圏活断層図）」(国土地理院。地図の右下のハザードマップで「活断層」を選んだときに重ねます)。調査者は図ごとに異なり、国土地理院の「",
      { text: "活断層図（都市圏活断層図）について", href: GSI_AFM },
      "」の各図に明記されています (例: 岡田篤正・廣内大助・松多信尚・宮内崇裕(2017):1:25,000都市圏活断層図「中津川」，国土地理院．)",
    ],
  },
  {
    // ODC Attribution License 1.0 の 4.3 の文のまま (データの名前と、ライセンスへのリンク)
    label: "プレート境界",
    parts: [
      "Contains information from ",
      { text: "PB2002", href: PB2002 },
      " (Bird, 2003; Hugo Ahlenius, Nordpil) which is made available under the ",
      { text: "ODC Attribution License", href: ODC_BY },
      "。2003 年の研究の模型の線で、どの機関の公式の線でもありません。簡略化して表示しています",
    ],
  },
  {
    label: "場所の検索",
    parts: [
      "市町村は気象庁の予報区等 GIS データから作った手元の表で探します。住所・地名は国土地理院の「",
      { text: "地理院地図", href: GSI_MAPS },
      "」の住所検索 (住所は「",
      { text: "CSISシンプルジオコーディング実験", href: CSIS_GEOCODE },
      "（街区レベル位置参照情報）」による) に、ブラウザから直接問い合わせます。送るのは打った文字だけで、sonae のサーバーには送らず、残しません",
    ],
  },
  {
    label: "指定緊急避難場所・指定避難所",
    parts: [
      "出典：国土地理院「",
      { text: "指定緊急避難場所・指定避難所データ", href: GSI_SHELTERS },
      "」",
    ],
  },
  {
    label: "ハザードマップ",
    parts: [
      "出典：「",
      { text: "ハザードマップポータルサイト", href: DISAPORTAL },
      "」。「ハザードマップポータルサイト」を加工して作成 (透かして重ねて表示)。元のデータ: 洪水浸水想定区域（想定最大規模）は国土交通省各地方整備局等・都道府県、土砂災害警戒区域は国土数値情報（土砂災害警戒区域）をもとに国土地理院が加工、津波浸水想定は都道府県",
    ],
  },
  {
    label: "緊急地震速報",
    parts: ["Wolfx Project・P2P地震情報"],
  },
  {
    label: "地震情報・津波予報の速報",
    parts: ["P2P地震情報"],
  },
  {
    label: "海外の地震",
    parts: [
      "Earthquake data courtesy of the U.S. Geological Survey・EMSC-CSEM SeismicPortal, ",
      {
        text: "https://www.seismicportal.eu",
        href: "https://www.seismicportal.eu",
      },
      " (CC BY 4.0、M4.5 以上を選んで表示)",
    ],
  },
  {
    label: "ニュージーランドの地震",
    parts: [
      "We acknowledge the New Zealand GeoNet programme and its sponsors NHC, Earth Sciences NZ, LINZ, NEMA and MBIE for providing data (CC BY 3.0 NZ)",
    ],
  },
  {
    label: "台湾付近の地震",
    parts: ["交通部中央氣象署 (政府資料開放授權條款 第 1 版)"],
  },
  {
    label: "太平洋の津波の参考情報",
    parts: [
      "NOAA/NWS Pacific Tsunami Warning Center (PTWC)。米国の政府の情報で、気象庁の発表ではありません",
    ],
  },
];

/** 出典の文の字だけ (試験と、字で出すところ) */
export const creditText = (c: Credit) =>
  `${c.label}: ${c.parts.map((p) => (typeof p === "string" ? p : p.text)).join("")}`;

/** 一覧の下と地図の隅に出す短い出典 (全文は「出典と注意」の窓) */
export const SHORT_CREDIT = "出典: 気象庁ホームページ・国土地理院 ほか";

/**
 * 地図の隅に、いつも見えるように出す短い出典 (国土地理院の出典の記載
 * https://www.gsi.go.jp/LAW/2930-meizi.html の「表示されている間は、常に見えるように」)。
 * ハザードマップを重ねているとき (`hazard` はその出典の名前。ハザードマップポータルサイトか都市圏活断層図。
 * 重ねていなければ空) と、GRUS 画像の範囲 (沖ノ鳥島のあたり) を映しているときはそれも足す
 */
export function mapCredit(opts: { hazard: string; grus: boolean }): string {
  const parts = ["国土地理院", "気象庁"];
  if (opts.hazard) parts.push(opts.hazard);
  if (opts.grus) parts.push("GRUS画像（© Axelspace）");
  return `出典: ${parts.join("・")} ほか`;
}

/**
 * GRUS 画像の範囲 (地理院タイル一覧の「写真」の備考: 北緯 20°24′28″〜20°27′21″、東経 136°03′58″〜136°08′25″)
 * [西, 南, 東, 北]
 */
export const GRUS_BOX: [number, number, number, number] = [
  136 + 3 / 60 + 58 / 3600,
  20 + 24 / 60 + 28 / 3600,
  136 + 8 / 60 + 25 / 3600,
  20 + 27 / 60 + 21 / 3600,
];

/**
 * GRUS 画像を含む写真のタイルを映しているか。GRUS 画像は「写真」(ズーム 14〜18 のシームレス空中写真) の一部なので、
 * そのタイルを読み始める少し手前 (ズーム 13) から、見ている範囲 [西, 南, 東, 北] が GRUS 画像の範囲にかかるときだけ
 */
export const showsGrus = (
  [w, s, e, n]: [number, number, number, number],
  zoom: number,
) =>
  zoom >= 13 &&
  w <= GRUS_BOX[2] &&
  e >= GRUS_BOX[0] &&
  s <= GRUS_BOX[3] &&
  n >= GRUS_BOX[1];

/**
 * 防災科研の公式の強震モニタ。リンクだけを置き、データは取らず埋め込みもしない
 * (docs/design.md 1 章の「入れない」。地図に重ねるのは防災科研に問い合わせてから)
 */
export const KMONI_URL = "http://www.kmoni.bosai.go.jp/";
