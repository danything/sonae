# Called from installers.yml (Windows). Checks that the VOICEVOX engine installed by install.ps1 answers,
# can synthesize with the default voice (Kenzaki Mesuo, 21), and that sonae connected to it.
# ASCII only: Windows PowerShell 5.1 reads a script without a BOM as ANSI (see install.sh check-voicevox.sh for the same in bash).
$ErrorActionPreference = 'Stop'
$vv = 'http://127.0.0.1:50121'
for ($i = 0; $i -lt 150; $i++) {
    & curl.exe -fs --max-time 5 -o NUL "$vv/version"
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
}
Write-Host "VOICEVOX $(& curl.exe -fsS "$vv/version")"
$query = Join-Path $env:RUNNER_TEMP 'query.json'
$wav = Join-Path $env:RUNNER_TEMP 'voice.wav'
& curl.exe -fsS -X POST -o $query "$vv/audio_query?speaker=21&text=%E3%83%86%E3%82%B9%E3%83%88"
if ($LASTEXITCODE -ne 0) { throw 'audio_query' }
& curl.exe -fsS -X POST -H 'Content-Type: application/json' --data-binary "@$query" -o $wav "$vv/synthesis?speaker=21"
if ($LASTEXITCODE -ne 0) { throw 'synthesis' }
$head = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($wav), 0, 4)
if ($head -ne 'RIFF') { throw "not a WAV: $head" }
# sonae retries the connection every 60 seconds. The log line is "[voicevox] tsunagarimashita" in Japanese
$log = "$env:ProgramData\sonae\logs\sonae.log"
$connected = '\[voicevox\] ' + [regex]::Unescape('つながりました')
for ($i = 0; $i -lt 60; $i++) {
    if (Select-String -LiteralPath $log -Pattern $connected -Quiet -Encoding UTF8) { return }
    Start-Sleep -Seconds 3
}
Get-Content -LiteralPath $log -Tail 50 -Encoding UTF8
throw 'sonae did not connect to VOICEVOX'
