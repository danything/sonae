# 海しる (海洋状況表示システム) の API の答え

2026-11-20 に海しる API (`https://api.msil.go.jp/<path>/v2/MapServer/1/query?f=geojson&where=1=1&outFields=*`) から取った答えを、点を数個に縮めたものです。点の属性は変えていません。

- `seabed-crust-deformation-info.json`: 海底地殻変動観測点 (31 点のうち 3 点)
- `marine-volcano-DB.json`: 海域火山DB (35 点のうち 4 点。標高の書き方が違うもの (`732m`・`-81m`・`‐95m`・空) を選んだ)

次の 3 つは本物の答えではありません (2026-11-28 に足した。手元に API のキーが無いため)。海しるの開発者ポータル (<https://portal.msil.go.jp/>) の各 API の仕様にある答えの例を写し、**作り物の点を足した**ものです。

- `coast-guard-office.json`: 海上保安部署等 (`coast-guard-office/v2/MapServer/1/query`)。1 点目 (横須賀海上保安部) は仕様の例のまま。2 点目「作り物海上保安署」は作り物 (海上保安庁でない URL を捨てるのを試す)
- `tide-station.json`: 潮汐推算の推算地点一覧 (`tide-prediction/v3/station`)。1 点目 (根室) は仕様の例のまま。2 点目「作り物港」と 3 点目 (形の違うコード) は作り物
- `tide-data-example.json`: 潮汐推算の推算潮位 (`tide-prediction/v3/data`) の仕様の例のまま (24 個しか並ばない例。1 分ごとの本物の答えは試験の中で作る)

出典：海洋状況表示システム（https://www.msil.go.jp/）。「海底地殻変動観測点」「海域火山DB」を加工して作成 (点を選んで縮めた)。
このサービスは、海しるAPIを利用して取得した情報をもとに作成しているが、サービスの内容は海上保安庁によって保証されたものではない。
