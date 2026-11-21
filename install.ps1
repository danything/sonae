# ---------------------------------------------------------------------------
# sonae を Windows (x64) に立てる。**管理者の PowerShell の 1 行で、ブラウザが開くところまで。**
#
#   irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/danything/sonae/main/install.ps1))) -Uninstall
#       引数を渡すときはこの書き方。-NoOpen (ブラウザを開かない) / -Uninstall (止めて外す。DB と設定は残す)
#
# **sonae 本体も VOICEVOX のエンジンも Windows の上でそのまま動かす** (コンテナは使わない)。本体は配布物の bun と
# ビルドしたアプリ (`sonae-<バージョン>-windows-x64.zip`)、VOICEVOX は公式のエンジンの Windows 用 (CPU 版。
# VOICEVOX/voicevox_engine の GitHub のリリース)。どちらもタスク スケジューラの「起動したら起こす」タスクに **SYSTEM で**
# 載せるので、誰もログインしていなくても動き、地震を受けられる。そのために管理者で流す。
#
# もう一度流せば最新に上げ直す (VOICEVOX は 2 GB ほどあるので、バージョンが変わったときだけ取り直す)。
# **Web Push の VAPID の鍵は、無ければ作る** (docs/push.md と同じ作り方)。一度作ったら替えない。
# **誰を通すか:** この PC のブラウザ (ループバック) と家の LAN からはログインなしで開けるように、sonae.env に TRUSTED_NETWORKS を
# 書く (無いときだけ)。**その中の誰でも設定を変えられる。** 外からも開くなら OIDC を sonae.env に書く (docs/install.md の「ログイン」)。
#
# 置き場:
#   %ProgramFiles%\sonae\    server\ (bun とアプリ)・voicevox\ (VOICEVOX のエンジン)。管理者しか書けない
#   %ProgramData%\sonae\     DB (sonae.db)・sonae.env (環境変数と秘密。無いときだけ雛形を作る)・起こす sonae.cmd と voicevox.cmd・
#                            logs\ (sonae.log・voicevox.log)。SYSTEM と管理者だけが読み書きできる
#
# 環境変数: SONAE_VERSION (v1.2.3 のように。既定は最新のリリース)、SONAE_SERVER_ZIP (手元で組んだ本体の zip を絶対パスで。CI と開発用)、
# SONAE_VAPID_SUBJECT (Web Push の連絡先。mailto:… か https://…。既定はこのリポジトリの URL)
#
# Windows に最初から入っている PowerShell 5.1 で動くように書く (pwsh でも動く)。
# `irm | iex` は呼んだ人のセッションでそのまま走るので、exit は使わない (窓ごと閉じる)。
# ---------------------------------------------------------------------------
param([switch]$NoOpen, [switch]$Uninstall)

$Repo = 'danything/sonae'
$WebPort = 3030
$Url = "http://localhost:$WebPort"
# VOICEVOX のエンジンが待ち受ける (ループバックだけ)。VOICEVOX のアプリ (50021) と重ならないように別にする
$VoicevoxPort = 50121
$Prefix = Join-Path $env:ProgramFiles 'sonae'
$Data = Join-Path $env:ProgramData 'sonae'
$Logs = Join-Path $Data 'logs'
$ServerTask = 'sonae'
$VoicevoxTask = 'sonae-voicevox'
$FirewallRule = 'sonae'
$VapidSubjectDefault = "https://github.com/$Repo"
$System = 'S-1-5-18'
$Administrators = 'S-1-5-32-544'
# 動く Windows の下限のビルド (Windows 10 1809 / Windows Server 2019)。bun と curl.exe がそれより前を受けない
$MinBuild = 17763

function Say([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# **stderr を捨てる外のコマンドの前に。** PowerShell 5.1 は、止める設定 (Stop) のまま 2>$null すると stderr の 1 行目で止まる
function Use-Continue { Set-Variable -Scope 1 -Name ErrorActionPreference -Value Continue }

# 取ってくる。PowerShell 5.1 の Invoke-WebRequest は遅いので、Windows 10 から入っている curl.exe で。時間の上限を付ける
function Get-Url([string]$From, [string]$To) {
    & curl.exe -fsSL --retry 3 --connect-timeout 20 --max-time 1800 -o $To $From
    if ($LASTEXITCODE -ne 0) { throw "ダウンロードできません: $From" }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected.ToUpperInvariant()) {
        throw "$Path のハッシュが合いません (ダウンロード中に壊れた可能性があります。もう一度流してください)"
    }
}

# 入れるバージョン。API を使わず、latest の転送先からタグを読む (install.sh と同じ)。リリースがまだ無いと /releases に転送される
function Get-Version {
    if ($env:SONAE_VERSION) { return $env:SONAE_VERSION }
    $tag = & curl.exe -fsLI --connect-timeout 20 --max-time 60 -o NUL -w '%{url_effective}' "https://github.com/$Repo/releases/latest"
    if ($LASTEXITCODE -ne 0) { throw '最新のリリースが分かりません' }
    if ($tag -notmatch '/releases/tag/') { throw 'sonae にはまだリリースがありません' }
    return ($tag -split '/')[-1]
}

# ファイルは BOM 無しの UTF-8 で書く (PowerShell 5.1 の Set-Content は BOM を付ける)
function Write-Text([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# 1 行足す (最後が改行で終わっていなければ、改行を足してから)
function Add-Line([string]$Path, [string]$Line) {
    $text = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' }
    if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
    Write-Text $Path ($text + $Line + "`n")
}

# KEY= の行があるか (コメントにした行は数えない)
function Test-EnvKey([string]$Path, [string]$Key) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return [bool](Select-String -LiteralPath $Path -Pattern "^$Key=" -Quiet)
}

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-Health {
    Use-Continue
    & curl.exe -fs --max-time 5 -o NUL "http://127.0.0.1:$WebPort/health"
    return $LASTEXITCODE -eq 0
}

# フォルダの持ち主と DACL を書く。許すのは $Sids (FullControl、下にも継がせる) だけで、親からは継がない。
# **フォルダがリンク (junction など) なら止める** (リンク先の権限を書き換えてしまう)。持ち主は icacls で
function Set-Owned([string]$Path, [string[]]$Sids, [string]$Owner) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path | Out-Null }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Path がリンクになっています。中身を確かめて消してから、もう一度流してください"
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $Sids) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule (New-Object Security.Principal.SecurityIdentifier $sid),
                'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    $info = Get-Item -LiteralPath $Path
    try {
        if ($info.PSObject.Methods['SetAccessControl']) { $info.SetAccessControl($acl) }
        else { [IO.FileSystemAclExtensions]::SetAccessControl($info, $acl) }
    } catch {
        throw "$Path の権限を整えられません ($($_.Exception.Message))"
    }
    & icacls.exe $Path /setowner "*$Owner" /q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$Path の持ち主を変えられません (icacls /setowner)" }
}

# 起こす .cmd を書く。**落ちたら 5 秒置いて起こし直す** (タスク スケジューラの「失敗したら再起動」は終了コードでは効かない)。
# $EnvFile があれば**起こすたびに読み直し**、そのあとで $Vars を書く (ファイルに置き場やポートを書いても、こちらが勝つ)。
# パスに日本語が入りうるので、1 行目で cmd の文字コードを UTF-8 にしてから読ませる
function Write-Loop([string]$Path, [Collections.Specialized.OrderedDictionary]$Vars, [string]$EnvFile, [string]$Dir, [string]$Command, [string]$LogFile) {
    $esc = { param([string]$Text) $Text.Replace('%', '%%') }
    $lines = @('@chcp 65001 >nul', '@echo off', 'rem Written by install.ps1 (sonae). Re-run the installer instead of editing this file.')
    if ($Dir) { $lines += "cd /d `"$(& $esc $Dir)`"" }
    $lines += ':loop', 'setlocal'
    if ($EnvFile) {
        $lines += "if exist `"$(& $esc $EnvFile)`" for /f `"usebackq eol=# tokens=1,* delims==`" %%a in (`"$(& $esc $EnvFile)`") do set `"%%a=%%b`""
    }
    foreach ($key in $Vars.Keys) { $lines += "set `"$key=$(& $esc ([string]$Vars[$key]))`"" }
    $lines += "$Command >> `"$(& $esc $LogFile)`" 2>&1", 'endlocal', 'ping -n 6 127.0.0.1 >nul', 'goto loop'
    Write-Text $Path (($lines -join "`r`n") + "`r`n")
}

# 起動したら起こすタスク (SYSTEM。誰もログインしていなくても動く)。時間の上限は外す (既定は 3 日で止められる)
function Register-Loop([string]$Name, [string]$Cmd, [string]$Description, [int]$Priority) {
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument "/d /c `"$Cmd`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $settings.Priority = $Priority
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description $Description -Force | Out-Null
}

# 止める。タスクを止めても .cmd の下で起きたもの (bun・VOICEVOX の run.exe) までは止まらないので、
# コマンドラインに置き場が入っているもので見つけて落とす。$Names は落とす実行ファイルの名前
function Stop-Part([string]$Task, [string[]]$Names, [string]$Under) {
    if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
    }
    $names = @('cmd.exe', 'conhost.exe') + $Names
    for ($i = 0; $i -lt 30; $i++) {
        $left = @(Get-CimInstance Win32_Process | Where-Object {
                $_.Name -in $names -and $_.CommandLine -and (
                    $_.CommandLine.IndexOf($Under, [StringComparison]::OrdinalIgnoreCase) -ge 0)
            })
        if ($left.Count -eq 0) { return }
        $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    throw "$Task が止まりません ($Under の下のプロセスをタスク マネージャーで止めてから、もう一度流してください)"
}

function Stop-Server { Stop-Part $ServerTask @('bun.exe') "$Prefix\server\"; Stop-Part $ServerTask @() "$Data\sonae.cmd" }
function Stop-Voicevox { Stop-Part $VoicevoxTask @('run.exe') "$Prefix\voicevox\"; Stop-Part $VoicevoxTask @() "$Data\voicevox.cmd" }

# zip をまるごと $To (まだ無いフォルダ) に開く。Expand-Archive は 5.1 だとファイルの多い zip で何分も掛かる
function Expand-Zip([string]$Path, [string]$To) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Path, $To)
}

# 本体の配布物を取って $Work\new\server に開く
function Get-Server([string]$Ref, [string]$Work) {
    $zip = $env:SONAE_SERVER_ZIP
    if (-not $zip) {
        if ($Ref -notmatch '^v?\d+\.\d+\.\d+$') { throw "Windows は配布物から入れるので、リリースのバージョン (v1.2.3 の形) を渡してください: $Ref" }
        $name = "sonae-$($Ref -replace '^v', '')-windows-x64.zip"
        $zip = Join-Path $Work $name
        Say "sonae $Ref"
        Get-Url "https://github.com/$Repo/releases/download/$Ref/$name" $zip
        Get-Url "https://github.com/$Repo/releases/download/$Ref/$name.sha256" "$zip.sha256"
        Assert-Hash $zip ((Get-Content -LiteralPath "$zip.sha256" -Raw) -split '\s+')[0]
    }
    Expand-Zip $zip "$Work\new\server"
    foreach ($file in 'bun.exe', 'app\build\index.js', 'app\package.json', 'voicevox.txt') {
        if (-not (Test-Path -LiteralPath "$Work\new\server\$file")) { throw "sonae の zip に $file が入っていません" }
    }
    # ブラウザで落とした zip を手で渡されたときの「インターネットから来た」印を外す (SmartScreen に止められないように)
    Get-ChildItem -Recurse -File "$Work\new" | Unblock-File
}

# VOICEVOX のエンジンを $Work\new\voicevox に揃える。**入っているものと同じバージョンなら取らず $false を返す** (2 GB ほどある)。
# 取り方は配布物の voicevox.txt (install.sh の mac_voicevox と同じ。part を順につなぐと vvpp (zip) になる)
function Get-Voicevox([string]$Work) {
    $manifest = Get-Content -LiteralPath "$Work\new\server\voicevox.txt"
    $version = ($manifest | Where-Object { $_ -match '^version ' } | Select-Object -First 1) -replace '^version ', ''
    if (-not $version) { throw 'voicevox.txt に version がありません' }
    $marker = "$Prefix\voicevox\VERSION"
    if ((Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $version) -and
        (Test-Path -LiteralPath "$Prefix\voicevox\run.exe")) {
        Say "VOICEVOX $version は入っています"
        return $false
    }
    # 一時フォルダ (取ってきて開く) と Program Files (置く。別のドライブならそちらにも写す) の両方に空きが要る
    foreach ($path in $Work, $env:ProgramFiles) {
        $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($path).Substring(0, 1))
        if ($drive.Free -lt 6GB) { throw "VOICEVOX を置くのに $($drive.Name): に 6 GB ほど要ります ($([math]::Round($drive.Free / 1GB, 1)) GB しか空いていません)" }
    }
    Say "VOICEVOX のエンジン $version を取ってきます (2 GB ほど。数分かかります)"
    $engine = Join-Path $Work 'engine.zip'
    $out = [IO.File]::Create($engine)
    try {
        $parts = @($manifest | Where-Object { $_ -match '^part ' })
        if ($parts.Count -eq 0) { throw 'voicevox.txt に part がありません' }
        foreach ($line in $parts) {
            $fields = $line -split ' '
            $part = Join-Path $Work 'part'
            Get-Url "https://github.com/VOICEVOX/voicevox_engine/releases/download/$version/$($fields[2])" $part
            Assert-Hash $part $fields[1]
            $in = [IO.File]::OpenRead($part)
            try { $in.CopyTo($out) } finally { $in.Dispose() }
            Remove-Item -Force -LiteralPath $part
        }
    } finally {
        $out.Dispose()
    }
    Say 'VOICEVOX を開きます'
    Expand-Zip $engine "$Work\new\voicevox"
    Remove-Item -Force -LiteralPath $engine
    if (-not (Test-Path -LiteralPath "$Work\new\voicevox\run.exe")) { throw 'VOICEVOX の zip に run.exe が入っていません' }
    Write-Text "$Work\new\voicevox\VERSION" "$version`n"
    Get-ChildItem -Recurse -File "$Work\new\voicevox" | Unblock-File
    return $true
}

# sonae.env の雛形 (無いときだけ。手で書き足す場所) と、VAPID の鍵 (無ければ作る。一度作ったら替えない)
function Initialize-Env([string]$Bun, [string]$Work) {
    $envFile = Join-Path $Data 'sonae.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        Write-Text $envFile ((@(
                    '# sonae の環境変数 (docs/install.md の「環境変数を足す」)。install.ps1 は無いときだけ作り、あとは触らない',
                    '# (VAPID の鍵の行が無ければ足すだけ)。直したら install.ps1 を流し直す。秘密が入るので人に見せない',
                    '# 値は引用符で囲まずに書く (書いた文字がそのまま渡る)',
                    '#',
                    '# 誰を通すか (docs/install.md の「ログイン」)。このネットワークの中からは、ログインなしで開ける。',
                    '# **その中の誰でも、設定 (読み上げの声・通知の条件・Web Push の購読) を変えられる。** 家の LAN だけにし、0.0.0.0/0 にはしない。',
                    '# 外から開くなら OIDC (下) を使う。http の LAN の IP (http://192.168.x.x:3030) で開くと、Web Push は使えない (localhost か https で開く)',
                    'TRUSTED_NETWORKS=127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8',
                    '# このほかの名前 (自分のドメイン・Tailscale の名前) で、ログインなしで開くなら書く (IP・localhost・PC の名前などは要らない)',
                    '# ALLOWED_HOSTS=sonae.example.com',
                    '#',
                    '# ログイン (OIDC)。3 つ揃えば、上のネットワークの外からもログインして開ける (docs/entra.md)。IdP には <開く URL>/auth/callback を登録する',
                    '# OIDC_ISSUER=https://login.microsoftonline.com/<テナントの ID>/v2.0',
                    '# OIDC_CLIENT_ID=',
                    '# OIDC_CLIENT_SECRET=',
                    '# 通すロール (既定 admin)',
                    '# OIDC_ROLE=admin',
                    '# 外から https で開くなら、その URL (ログインの戻り先と Webhook の本文のリンクに使う)',
                    '# PUBLIC_URL=https://sonae.example.com',
                    '# https の前段 (リバースプロキシ) の後ろに置くなら、PUBLIC_URL と同じ値も書く (CSRF の判定。無いとログアウトが 403 になることがある)',
                    '# ORIGIN=https://sonae.example.com',
                    '# 台湾の中央氣象署の授権碼 (docs/cwa.md)',
                    '# CWA_API_KEY=',
                    '# 海しる (海上保安庁) の API のキー。無ければ海しるの点を出さない (docs/design.md の 2.11)',
                    '# MSIL_API_KEY=',
                    '# 災害時の通行止めは、国土交通省 道路局のページから通れるマップを自動で見つける。切るなら off (docs/design.md の 2.12)',
                    '# SONAE_ROAD_DISCOVER=off',
                    '# 自動で見つからない災害の予備。通れるマップの GeoJSON の URL (https の *.go.jp。カンマか空白で区切る)',
                    '# SONAE_ROAD_GEOJSON='
                ) -join "`n") + "`n")
    }
    if (-not (Test-EnvKey $envFile 'VAPID_PRIVATE_JWK')) {
        Say 'Web Push の鍵 (VAPID) を作ります'
        # 引用符を含む JS は、PowerShell 5.1 から外のコマンドの引数にうまく渡せないので、ファイルにして渡す
        $js = Join-Path $Work 'vapid.mjs'
        Write-Text $js 'const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]); console.log(JSON.stringify(await crypto.subtle.exportKey("jwk", k.privateKey)))'
        $jwk = (& $Bun $js | Select-Object -Last 1)
        if ($LASTEXITCODE -ne 0 -or -not $jwk -or $jwk -notmatch '"crv":"P-256"') { throw 'VAPID の鍵を作れませんでした' }
        Add-Line $envFile '# Web Push の鍵 (install.ps1 が作った。替えると、どのブラウザの購読にも送れなくなる。docs/push.md)'
        Add-Line $envFile "VAPID_PRIVATE_JWK=$($jwk.Trim())"
    }
    if (-not (Test-EnvKey $envFile 'VAPID_SUBJECT')) {
        $subject = if ($env:SONAE_VAPID_SUBJECT) { $env:SONAE_VAPID_SUBJECT } else { $VapidSubjectDefault }
        Add-Line $envFile '# Web Push の配信サービスが困ったときの連絡先。自分の mailto:… に替えてよい'
        Add-Line $envFile "VAPID_SUBJECT=$subject"
    }
    return $envFile
}

function Register-Voicevox {
    $vars = [ordered]@{}
    $cmd = "$Data\voicevox.cmd"
    Write-Loop $cmd $vars '' "$Prefix\voicevox" "`"$Prefix\voicevox\run.exe`" --host 127.0.0.1 --port $VoicevoxPort" "$Logs\voicevox.log"
    # 優先度は普通より少し低く (7 は「低い」。読み上げは地震のときに要るので、そこまでは下げない)
    Register-Loop $VoicevoxTask $cmd 'sonae の読み上げの声を作る VOICEVOX のエンジン (install.ps1 が入れた)' 6
    Start-ScheduledTask -TaskName $VoicevoxTask
}

# sonae 本体を起こす .cmd とタスク。**置き場・ポート・VOICEVOX の宛先はここで決め、sonae.env より勝たせる**
function Register-Server([string]$EnvFile) {
    $server = "$Prefix\server"
    $vars = [ordered]@{
        NODE_ENV = 'production'
        TZ = 'Asia/Tokyo'
        SONAE_DATA = $Data
        PORT = $WebPort
        HOST = '0.0.0.0'
        VOICEVOX_URL = "http://127.0.0.1:$VoicevoxPort"
        CONNECTION_IDLE_TIMEOUT = '255'
        SHUTDOWN_TIMEOUT = '5'
        # bun が変換した .ts を SYSTEM のフォルダへ溜めない
        BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0'
    }
    # 秘密 (sonae.env) を読むので、SYSTEM と管理者だけが読める $Data に置く
    $cmd = "$Data\sonae.cmd"
    Write-Loop $cmd $vars $EnvFile "$server\app" "`"$server\bun.exe`" .\build\index.js" "$Logs\sonae.log"
    Register-Loop $ServerTask $cmd 'sonae 本体 (install.ps1 が入れた)' 4

    Remove-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name $FirewallRule -DisplayName 'sonae' -Description 'sonae の画面 (install.ps1 が足した)' `
        -Direction Inbound -Protocol TCP -LocalPort $WebPort -Profile Domain, Private -Action Allow | Out-Null

    Start-ScheduledTask -TaskName $ServerTask
    Say 'sonae の応答を待ちます'
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Health) {
            Say "起動しました: $Url (LAN のほかの機器からは http://$($env:COMPUTERNAME):$WebPort)"
            Say 'LAN のほかの機器から開けないときは、Windows の設定でこの PC のネットワークを「プライベート」にしてください'
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "sonae が応答しません。ログを見てください: $Logs\sonae.log"
}

function Install-Sonae([string]$Ref) {
    $work = Join-Path ([IO.Path]::GetTempPath()) "sonae-install-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path "$work\new" | Out-Null
    try {
        # --- 揃えてから止める (取ってこられなかったら、動いているものに触らない) ---
        Get-Server $Ref $work
        $voicevoxNew = Get-Voicevox $work
        # 置き場と sonae.env (VAPID の鍵は取ってきた bun で作る) も、止める前に済ませる (失敗しても、動いているものに触らない)
        Set-Owned $Data @($System, $Administrators) $Administrators
        New-Item -ItemType Directory -Force -Path $Logs | Out-Null
        $envFile = Initialize-Env "$work\new\server\bun.exe" $work
        Stop-Server
        if ($voicevoxNew) { Stop-Voicevox }
        New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
        $parts = @('server')
        if ($voicevoxNew) { $parts += 'voicevox' }
        # 前のものは .old に退けてから入れ替え、入ってから消す (途中で落ちても、前のものが残る)
        foreach ($part in $parts) {
            $old = "$Prefix\$part.old"
            if (Test-Path -LiteralPath $old) { Remove-Item -Recurse -Force -LiteralPath $old }
            if (Test-Path -LiteralPath "$Prefix\$part") { Move-Item -LiteralPath "$Prefix\$part" -Destination $old }
            try {
                Move-Item -LiteralPath "$work\new\$part" -Destination "$Prefix\$part"
            } catch {
                if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination "$Prefix\$part" }
                throw "$Prefix\$part に置けません ($($_.Exception.Message))"
            }
            if (Test-Path -LiteralPath $old) { Remove-Item -Recurse -Force -LiteralPath $old }
        }
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }
    # VOICEVOX は入れ替えたときと、タスクが無いときだけ起こし直す (モデルを読むのに時間が掛かる)
    if ($voicevoxNew -or -not (Get-ScheduledTask -TaskName $VoicevoxTask -ErrorAction SilentlyContinue)) { Register-Voicevox }
    Register-Server $envFile
    $trusted = Select-String -LiteralPath $envFile -Pattern '^TRUSTED_NETWORKS=(.*)$' | Select-Object -Last 1
    if ($trusted) {
        Say "ログインなしで開けるのは $($trusted.Matches[0].Groups[1].Value) の中からです。その中の誰でも設定を変えられます (変えるなら $envFile の TRUSTED_NETWORKS)"
    }
    if (-not (Test-EnvKey $envFile 'OIDC_CLIENT_SECRET')) {
        Say "外からも開くなら、$envFile に OIDC_ISSUER・OIDC_CLIENT_ID・OIDC_CLIENT_SECRET を書いて、もう一度流してください (docs/install.md の「ログイン」)"
    }
    Say '読み上げの声は VOICEVOX で作ります。使うときは VOICEVOX の利用規約 (https://voicevox.hiroshiba.jp/term/) と'
    Say '  声のキャラクターの規約に従ってください (既定の声は「VOICEVOX:剣崎雌雄」。docs/install.md の「VOICEVOX」)'
}

function Invoke-Main([switch]$NoOpen, [switch]$Uninstall) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    if (-not (Test-Admin)) {
        throw '管理者の PowerShell で流してください (スタートボタンを右クリックして「ターミナル (管理者)」)。sonae と VOICEVOX を、ログインしなくても動くタスク (SYSTEM) に載せるためです'
    }

    if ($Uninstall) {
        Stop-Server
        Stop-Voicevox
        foreach ($task in $ServerTask, $VoicevoxTask) {
            Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
        }
        Remove-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $Prefix) { Remove-Item -Recurse -Force -LiteralPath $Prefix }
        foreach ($file in 'sonae.cmd', 'voicevox.cmd') {
            if (Test-Path -LiteralPath "$Data\$file") { Remove-Item -Force -LiteralPath "$Data\$file" }
        }
        Say '外しました。残してあるもの (要らなければ手で消してください):'
        Say "  DB と sonae.env とログ $Data"
        return
    }

    $build = [int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    if ($build -lt $MinBuild) {
        throw "この Windows (ビルド $build) では動きません。Windows 10 1809 / Windows Server 2019 (ビルド $MinBuild) 以降が必要です"
    }
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw '対応しているのは x64 の Windows だけです (VOICEVOX の CPU 版が x64 用だけです)' }

    $ref = if ($env:SONAE_SERVER_ZIP) { '' } else { Get-Version }
    Install-Sonae $ref
    # 管理者の窓から開くとブラウザまで管理者で動くので、エクスプローラーに開かせる (ログインしている人のブラウザで開く)
    if (-not $NoOpen) { Start-Process "$env:WINDIR\explorer.exe" $Url }
}

Invoke-Main -NoOpen:$NoOpen -Uninstall:$Uninstall
