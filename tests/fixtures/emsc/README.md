# EMSC Seismic Portal の WebSocket

`made-messages.jsonl` は sonae が自分で作ったものです (1 行が WebSocket の 1 通)。
形は Seismic Portal の説明 (https://www.seismicportal.eu/realtime.html の受け取り側の例) の
`action` と `data.properties` (`unid`・`time`・`lastupdate`・`lat`・`lon`・`depth`・`mag`・`magtype`・`flynn_region`・`evtype`) に合わせました。
2026-11-14 に 3 分つないだときは 1 通も来なかったので、実物ではありません。

| 行  | 中身                                                                           |
| --- | ------------------------------------------------------------------------------ |
| 1   | M4.9 New Ireland Region (USGS の fixture の 1 件目と同じ地震とみなせる近さ)    |
| 2   | M2.1 Northern California (受ける下限 M4.5 より小さい)                          |
| 3   | M4.6 Poland の爆破 (`evtype` が `km`)                                          |
