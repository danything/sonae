# 海しる (海洋状況表示システム) の API の答え

2026-11-20 に海しる API (`https://api.msil.go.jp/<path>/v2/MapServer/1/query?f=geojson&where=1=1&outFields=*`) から取った答えを、点を数個に縮めたものです。点の属性は変えていません。

- `seabed-crust-deformation-info.json`: 海底地殻変動観測点 (31 点のうち 3 点)
- `marine-volcano-DB.json`: 海域火山DB (35 点のうち 4 点。標高の書き方が違うもの (`732m`・`-81m`・`‐95m`・空) を選んだ)

出典：海洋状況表示システム（https://www.msil.go.jp/）。「海底地殻変動観測点」「海域火山DB」を加工して作成 (点を選んで縮めた)。
このサービスは、海しるAPIを利用して取得した情報をもとに作成しているが、サービスの内容は海上保安庁によって保証されたものではない。
