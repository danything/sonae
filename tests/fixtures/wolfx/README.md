# Wolfx Open API (jma_eew・jma_eqlist) の JSON

**どれも sonae が自分で作ったもの (`made-`) です。** Wolfx から受けた本物の電文は入れていません
(Wolfx の規約で、原文 `OriginalText` の公開の再配布が禁じられているため)。

- 形の出典: Wolfx Open API Usage Guidelines の「JMA Earthquake Early Warning JSON API」の項目の一覧
  (https://wolfx.jp/en/docs/open-api/) と、WebSocket の heartbeat の説明 (https://wolfx.jp/en/docs/websocket/)
- 値は P2P地震情報の仕様書の 556 の例 (宗谷地方北部の地震) に合わせて作った。`OriginalText` は作り物の文
- `made-eqlist.json` (地震情報の一覧 `jma_eqlist`) は、同じ文書の「JMA Earthquake Information」の項目の一覧と、
  2026-11-16 に受けた一覧の形 (`No1` の中に `EventID`・`time_full` がある) に合わせて作った。値は気象庁の
  サンプル電文 (`tests/fixtures/jma/32-35_06_04_240613_VXSE53.xml`、岩手県内陸南部の地震) に合わせた作り物
- `made-special-eq.json` (南海トラフ・北海道・三陸沖の情報 `jma_special_eq`) は、同じ文書の「気象庁 特別地震情報 JSON API」の
  項目の一覧と、2026-11-28 に受けた形 (`reports[]` に `id`・`product`・`time`・`status`・`eventIds`・`kind`・`code`・`label`・`title`・`text`) に合わせて作った。
  VYSE50 の値は気象庁のサンプル電文 (`tests/fixtures/jma/74_01_01_200512_VYSE50.xml`、調査中) の文、VYSE52 は作り物。`id` は作り物 (Wolfx の id はハッシュ)
