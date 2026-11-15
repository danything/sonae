#!/usr/bin/env bash
# installers.yml (Mac) から: install.sh が入れた VOICEVOX のエンジンが答え、既定の声 (剣崎雌雄、21) で合成でき、
# sonae がつながったことを確かめる。エンジンはモデルを読むのに時間が掛かるので待つ
set -euo pipefail
vv=http://127.0.0.1:50121
for _ in $(seq 150); do
  if curl -fsS --max-time 5 "$vv/version" > /dev/null 2>&1; then break; fi
  sleep 2
done
echo "VOICEVOX $(curl -fsS "$vv/version")"
curl -fsS -X POST -o "${RUNNER_TEMP:-/tmp}/query.json" "$vv/audio_query?speaker=21&text=%E3%83%86%E3%82%B9%E3%83%88"
curl -fsS -X POST -H 'Content-Type: application/json' --data-binary "@${RUNNER_TEMP:-/tmp}/query.json" \
  -o "${RUNNER_TEMP:-/tmp}/voice.wav" "$vv/synthesis?speaker=21"
test "$(head -c 4 "${RUNNER_TEMP:-/tmp}/voice.wav")" = RIFF
# sonae は 60 秒ごとにつなぎ直す
for _ in $(seq 60); do
  if sudo grep -q '\[voicevox\] つながりました' /Library/Logs/sonae/sonae.log; then exit 0; fi
  sleep 3
done
sudo tail -n 50 /Library/Logs/sonae/sonae.log
echo "sonae が VOICEVOX につながりません" >&2
exit 1
