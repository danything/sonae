# プレート境界 (PB2002)

`pb2002-boundaries.geojson` は、sonae の地図に重ねるプレート境界の線です。
[`tools/plates/build.sh`](https://github.com/danything/sonae/blob/main/tools/plates/build.sh) で元のデータを簡略化して作りました (2 km 間隔に間引き、座標を 0.01 度に丸め、属性を外しています)。

Contains information from PB2002 (Bird, 2003; Hugo Ahlenius, Nordpil) which is made available under the ODC Attribution License.

- データの名前: PB2002 (plate boundaries)
- 元のデータ: Peter Bird, "An updated digital model of plate boundaries", Geochemistry Geophysics Geosystems, 4(3), 1027, 2003. [doi:10.1029/2001GC000252](https://doi.org/10.1029/2001GC000252)
- 整えて GeoJSON にしたもの: Hugo Ahlenius, Nordpil ([fraxen/tectonicplates](https://github.com/fraxen/tectonicplates)。コミット `339b0c56563c118307b1f4542703047f5f698fae` の `GeoJSON/PB2002_boundaries.json`)
- ライセンス: Open Data Commons Attribution License 1.0 (<https://opendatacommons.org/licenses/by/1-0/>)

元のリポジトリの表示 (LICENSE.md) は次のとおりです。

> This collection of data is made available under the Open Data Commons Attribution License: [http://opendatacommons.org/licenses/by/1.0/](http://opendatacommons.org/licenses/by/1.0/)

PB2002 は 2003 年の研究の模型で、どの機関の公式の線でもありません。境界の位置は模型の推定で、いまの研究と違う所もあります。
このファイルは上のライセンスのまま使えます。sonae のコードのライセンス (AGPL-3.0) はこのファイルには及びません。
