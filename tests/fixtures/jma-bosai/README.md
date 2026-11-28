# 気象庁ホームページ (bosai) の国際津波関連情報と、気象の JSON

国際津波関連情報は 2026-11-14 に取ったものです (変えていません)。
気象の JSON (気象 XML の予備。docs/design.md の 2.8) は 2026-11-28 に取ったものです。`area.json`・`warning-map.json`・`information.json` は、取ったものから一部を抜き出して縮めました (値は変えていません)。

| ファイル                                  | 元                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list.json`                               | `https://www.jma.go.jp/bosai/pacifictsunami/data/list.json` (1 か月分の電報の一覧)                                     |
| `20261025022014_0_WEPA40_RJTD.txt`        | `https://www.jma.go.jp/bosai/pacifictsunami/data/wepa40/20261025022014_0_WEPA40_RJTD.txt`                              |
| `area.json`                               | `https://www.jma.go.jp/bosai/common/const/area.json` の神奈川県の分 (府県予報区・一次細分区域・市町村等)               |
| `warning-map.json`                        | `https://www.jma.go.jp/bosai/warning/data/r8/map.json` の神奈川県の 5 つの報                                           |
| `information.json`                        | `https://www.jma.go.jp/bosai/information/data/r8/information.json` の府県気象防災速報 2 つと府県気象解説情報 1 つ      |
| `20261126190843_0_VPBS50_471000.json`     | `https://www.jma.go.jp/bosai/information/data/r8/denbun/20261126190843_0_VPBS50_471000.json` (沖縄本島地方の線状降水帯) |

- 出典: 気象庁ホームページ
- 利用条件: 気象庁ホームページの利用規約 (https://www.jma.go.jp/jma/kishou/info/coment.html 。公共データ利用規約 第 1.0 版)
- 公式の API ではなく、形は予告なく変わることがあります
