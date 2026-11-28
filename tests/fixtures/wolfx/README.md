# Wolfx Open API (jma_eew・jma_eqlist) の JSON

**どれも sonae が自分で作ったもの (`made-`) です。** Wolfx から受けた本物の電文は入れていません。
原文 (`OriginalText`) の中身は気象庁の緊急地震速報の電文で、Wolfx の規約の五条で気象庁の条件に従います。配り直してよいと確かめられないので、入れません (docs/design.md の 5 章)。

- 形の出典: Wolfx Open API の文書の「気象庁 緊急地震速報 JSON API」の項目の一覧 (https://wolfx.jp/docs/open-api) と、
  公式の応答の例 (https://wolfx.jp/examples/jma_eew/warning.json など。2026-11-23 に公開) の形。WebSocket の heartbeat は
  https://wolfx.jp/docs/websocket の説明
  - 公式の例は WolfxProject/wolfx-project-site (GPL-3.0) にあり、`OriginalText` に本物の電文が入っているので、そのままは写さない。
    項目の並び・`WarnArea[].Type` (`警報`・`予報`)・`Time` (`HHMMSS` か `//////`)・`Arrive` (「未到達」などの文) の書き方だけを合わせた
- 値は P2P地震情報の仕様書の 556 の例 (宗谷地方北部の地震) に合わせて作った。`OriginalText` は作り物の文
- `made-eqlist.json` (地震情報の一覧 `jma_eqlist`) は、同じ文書の「気象庁 地震情報 JSON API」の項目の一覧と、
  2026-11-16 に受けた一覧の形 (`No1` の中に `EventID`・`time_full` がある) に合わせて作った。値は気象庁の
  サンプル電文 (`tests/fixtures/jma/32-35_06_04_240613_VXSE53.xml`、岩手県内陸南部の地震) に合わせた作り物
- `made-special-eq.json` (南海トラフ・北海道・三陸沖の情報 `jma_special_eq`) は、同じ文書の「気象庁 特別地震情報 JSON API」の
  項目の一覧と、2026-11-28 に受けた形 (`reports[]` に `id`・`product`・`time`・`status`・`eventIds`・`kind`・`code`・`label`・`title`・`text`) に合わせて作った。
  VYSE50 の値は気象庁のサンプル電文 (`tests/fixtures/jma/74_01_01_200512_VYSE50.xml`、調査中) の文、VYSE52 は作り物。`id` は作り物 (Wolfx の id はハッシュ)
- `made-tsunami.json` (津波の警報・注意報・予報 `jma_tsunami`) は、同じ文書の「気象庁 津波情報 JSON API」の項目の一覧と、公式の例
  (https://wolfx.jp/examples/jma_tsunami/major_warning.json の形) に合わせて作った。値は気象庁のサンプル電文
  (`tests/fixtures/jma/32-39_11_02_250206_VTSE41.xml`、2011-03-11) の最初の 4 つの予報区。Wolfx が独自に決めた状態
  (`status`・`trusted`・`validUntil`・`lastKnown`) は、読まないことを確かめるために入れてある。`id` は作り物
