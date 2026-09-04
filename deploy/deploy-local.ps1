<#
.SYNOPSIS
    EvolutionWorld 本机 WSL2 直接部署（第二种部署方式，不走 GitHub 自托管 runner）。

.DESCRIPTION
    在 Windows 侧编排、在 WSL2 Ubuntu 内执行构建与部署：
      唤醒 WSL -> (必要时分级恢复) -> 调用 deploy/deploy_wsl.sh -> 构建 -> 停旧进程
      -> 部署到 /opt/evolutionworld -> 启动 -> 健康检查

    与 CI（.github/workflows/ci.yml）的差异：
      * 代码来源为本地工作副本，无需 git push / runner 领取任务；
      * 默认增量构建（CI 每次 rm -rf build 全量重建），可用 -Clean 强制全量；
      * 默认保留 /opt/evolutionworld/server/data 运行时配置（地形编辑 terrain_edit.json），
        CI 会整目录删除；账号/出生点已改为内存模式，不再持久化到文件；
        -WipeData 可对齐 CI 行为。

    WSL 使用注意（实测结论，勿改回）：
      1. WSL 虚拟机处于关闭状态时，首次 wsl 调用会打印
         "Provisioning the new WSL instance Ubuntu"，实测耗时可达 1-3 分钟。
         因此唤醒阶段必须给足超时（-WarmupTimeoutSec，默认 420s），
         超时过短会把正常的冷启动误判为失败。
      2. 不要无差别结束所有 wsl.exe：正在持有会话的客户端被杀可能连带拆掉 WSL VM，
         下次调用又要重新 provisioning。超时清理只针对本次调用新起的客户端。
      3. 不要用 wsl --shutdown：有用户会话时它会无限期挂死。
      4. 输出编码：WSL 侧脚本只输出 ASCII；本文件输出中文并保持控制台原有代码页，
         不修改 [Console]::OutputEncoding（本机为 gb2312，强改 UTF-8 反而乱码）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy/deploy-local.ps1
    完整部署（增量构建 + 重启 + 健康检查）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy/deploy-local.ps1 -Clean
    全量重建后部署。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy/deploy-local.ps1 -SkipBuild
    只改了客户端静态文件时，跳过 C++ 构建直接重新部署并重启。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy/deploy-local.ps1 -Status
    查看当前部署与运行状态。
#>
[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu',
    [int]$Port = 3000,
    [string]$Dest = '/opt/evolutionworld',
    [string]$RepoRoot = '',
    [switch]$Clean,
    [switch]$SkipBuild,
    [switch]$NoStart,
    [switch]$StopOnly,
    [switch]$Status,
    [switch]$WipeData,
    [switch]$NoDb,
    [string]$MysqlUser = 'root',
    [string]$MysqlPass = '123456',
    [string]$MysqlDb = 'evolution_world',
    [string]$LogFile = '/tmp/evolution_server.log',
    [int]$BuildTimeoutSec = 1800,
    [int]$WarmupTimeoutSec = 420,
    [int]$ProbeTimeoutSec = 25,
    [int]$ShortTimeoutSec = 600,
    [switch]$SkipWslRecover,
    [switch]$ForceWslReset,
    [switch]$NoWindowsHealthCheck,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
# WSL 命令的退出码经由输出标记回传（后台作业内读不到父作用域的 $LASTEXITCODE）
$script:EwExitCode = $null
$script:EwExitMarker = '___EW_EXIT___'

function Write-Title {
    param([string]$Text)
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Text)
    Write-Host "[deploy] $Text"
}

function Write-Ok {
    param([string]$Text)
    Write-Host "[  OK  ] $Text" -ForegroundColor Green
}

function Write-Warn2 {
    param([string]$Text)
    Write-Host "[ WARN ] $Text" -ForegroundColor Yellow
}

function Show-Usage {
    Write-Host @'
用法: deploy-local.ps1 [选项]

选项:
  -Distro <name>          WSL 发行版名称（默认 Ubuntu）
  -Port <n>               服务端口，注入 EW_PORT（默认 3000）
  -Dest <path>            WSL 内部署目录（默认 /opt/evolutionworld）
  -RepoRoot <path>        仓库根目录（默认按脚本位置推导）
  -Clean                  清空 build 目录全量重建（默认增量构建，更快）
  -SkipBuild              跳过 C++ 构建，直接用已有产物重新部署
  -NoStart                只构建 + 部署，不启动服务
  -StopOnly               仅停止正在运行的服务
  -Status                 仅查看部署 / 运行状态
  -WipeData               同时清空运行时数据（地形编辑等）
  -NoDb                   不注入 MySQL/Redis 配置（纯内存模式）
  -MysqlUser <u>          MySQL 用户（默认 root）
  -MysqlPass <p>          MySQL 密码（默认 123456）
  -MysqlDb <db>           MySQL 库名（默认 evolution_world）
  -LogFile <path>         WSL 内服务日志路径（默认 /tmp/evolution_server.log）
  -BuildTimeoutSec <n>    完整构建部署的超时（默认 1800 秒）
  -WarmupTimeoutSec <n>   WSL 冷启动唤醒超时，需覆盖 provisioning（默认 420 秒）
  -ProbeTimeoutSec <n>    WSL 快速探活超时（默认 25 秒）
  -ShortTimeoutSec <n>    -Status / -StopOnly / -SkipBuild 的超时（默认 600 秒）
  -SkipWslRecover         WSL 无响应时不自动恢复，直接报错退出
  -ForceWslReset          跳过分级恢复，直接在 Windows 层重启 WSL 后端
  -NoWindowsHealthCheck   跳过 Windows 侧的补充健康检查

示例:
  .\deploy\deploy-local.ps1
  .\deploy\deploy-local.ps1 -Clean
  .\deploy\deploy-local.ps1 -SkipBuild
  .\deploy\deploy-local.ps1 -Status
  .\deploy\deploy-local.ps1 -StopOnly
'@
}

# ---------------------------------------------------------------------------
# 路径与工具
# ---------------------------------------------------------------------------

function ConvertTo-WslPath {
    param([Parameter(Mandatory)][string]$WindowsPath)
    $full = (Resolve-Path -LiteralPath $WindowsPath).ProviderPath
    if ($full -match '^([A-Za-z]):[\\/](.*)$') {
        $drive = $Matches[1].ToLower()
        $rest = $Matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }
    if ($full -match '^([A-Za-z]):$') {
        return "/mnt/$($Matches[1].ToLower())"
    }
    return ($full -replace '\\', '/')
}

function Publish-JobOutput {
    param($Lines)
    foreach ($line in $Lines) {
        $text = [string]$line
        if ($text -match "^$([regex]::Escape($script:EwExitMarker))(-?\d+)\s*$") {
            $script:EwExitCode = [int]$Matches[1]
        }
        else {
            Write-Host $text
        }
    }
}

function Invoke-WslJob {
    <#
        在后台作业里执行 wsl 命令：既能边跑边把输出流式打到控制台，
        又能用超时兜住 WSL 挂死（直接前台调用会无限期阻塞）。
        返回退出码；超时时抛异常。
    #>
    param(
        [Parameter(Mandatory)][string[]]$WslArgs,
        [Parameter(Mandatory)][int]$TimeoutSec,
        [string]$Label = 'WSL 命令',
        [switch]$CaptureExitCode
    )
    # 记录调用前已存在的 wsl.exe，超时清理时只结束本次新起的客户端
    $preExisting = @(Get-Process -Name wsl -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $script:EwExitCode = $null

    # 注意：形参名不能叫 $args，那是 PowerShell 自动变量，会导致 splatting 异常
    $job = Start-Job -ScriptBlock {
        param($wslArguments, $marker, $capture)
        & wsl @wslArguments 2>&1 | ForEach-Object { [string]$_ }
        if ($capture) { "$marker$LASTEXITCODE" }
    } -ArgumentList @(, $WslArgs), $script:EwExitMarker, [bool]$CaptureExitCode

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        while ($true) {
            Start-Sleep -Milliseconds 500
            Publish-JobOutput -Lines @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
            if ($job.State -ne 'Running') {
                Start-Sleep -Milliseconds 300
                Publish-JobOutput -Lines @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
                break
            }
            if ($sw.Elapsed.TotalSeconds -gt $TimeoutSec) {
                Stop-Job -Job $job -ErrorAction SilentlyContinue
                Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
                # 残留的客户端会阻塞后续 WSL 调用，但只清理本次新起的那些：
                # 无差别杀光 wsl.exe 可能连带拆掉 WSL VM，下次调用又要重新 provisioning。
                $spawned = @(Get-Process -Name wsl -ErrorAction SilentlyContinue | Where-Object { $preExisting -notcontains $_.Id })
                if ($spawned.Count -gt 0) {
                    $spawned | Stop-Process -Force -ErrorAction SilentlyContinue
                    Write-Warn2 "已结束本次调用残留的 $($spawned.Count) 个 wsl.exe 客户端进程"
                }
                throw "$Label 超时（已运行 $([int]$sw.Elapsed.TotalSeconds)s，上限 ${TimeoutSec}s）。注意：WSL 内的脚本可能仍在继续执行，可先用 -Status 查看实际状态，再决定是否重试。"
            }
        }
    }
    finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }

    if (-not $CaptureExitCode) { return 0 }
    if ($null -eq $script:EwExitCode) {
        Write-Warn2 "未能取得 $Label 的退出码，按失败处理"
        return 1
    }
    return $script:EwExitCode
}

function Test-WslVmAlive {
    # vmmem / vmmemWSL 是 WSL2 虚拟机进程。用它区分两种完全不同的失败：
    #   VM 在跑但探活挂死 -> 残留 wsl.exe 客户端阻塞会话复用，清理客户端秒级恢复；
    #   VM 没在跑        -> 真冷启动，首次调用要 provisioning，只能耐心等。
    $vm = @(Get-Process -Name vmmem, vmmemWSL -ErrorAction SilentlyContinue)
    return ($vm.Count -gt 0)
}

function Invoke-WslWakeUp {
    <#
        唤醒 WSL 并确认发行版可用。
        冷启动（VM 已关闭）时 wsl 会先 provisioning，实测可达数分钟，
        这里用 -WarmupTimeoutSec 兜住，期间不做任何进程清理。
    #>
    param([string]$DistroName, [int]$TimeoutSec = 420)
    $code = Invoke-WslJob -WslArgs @('-d', $DistroName, '--', 'bash', '-c', 'echo WSL_READY') `
        -TimeoutSec $TimeoutSec -Label "WSL 唤醒 ($DistroName)" -CaptureExitCode
    return ($code -eq 0)
}

function Restore-WslSession {
    <#
        WSL 无响应时的分级恢复：
          阶段 1 —— 结束挂死的 wsl.exe 客户端（它们会阻塞 WSL 的会话复用）；
          阶段 2 —— Windows 层强杀 wslservice/wslhost（CI 同款做法）。
        全程不使用 wsl --shutdown（有用户会话时会无限期挂死）。
    #>
    param([string]$DistroName, [int]$TimeoutSec = 420, [switch]$Force)

    if (-not $Force) {
        Write-Title '=== WSL 无响应，开始分级恢复 ==='
        Write-Warn2 '阶段 1/2：结束挂死的 wsl.exe 客户端进程（已打开的 WSL 终端可能被关闭）'
        $stale = @(Get-Process -Name wsl -ErrorAction SilentlyContinue)
        if ($stale.Count -gt 0) {
            $stale | Stop-Process -Force -ErrorAction SilentlyContinue
            Write-Step "已结束 $($stale.Count) 个 wsl.exe 客户端进程"
        }
        else {
            Write-Step '没有发现残留的 wsl.exe 客户端进程'
        }
        Start-Sleep -Seconds 3
        if (Invoke-WslWakeUp -DistroName $DistroName -TimeoutSec $TimeoutSec) {
            Write-Ok 'WSL 已恢复响应（仅清理客户端进程即可）'
            return
        }
    }

    Write-Warn2 '阶段 2/2：在 Windows 层强制重启 WSL 后端（wslservice / wslhost），WSL 内正在运行的服务会一并终止'
    Get-Process -Name wslservice, wslhost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Get-Process -Name wslservice -ErrorAction SilentlyContinue) { & taskkill /F /IM wslservice.exe 2>$null | Out-Null }
    if (Get-Process -Name wslhost -ErrorAction SilentlyContinue)   { & taskkill /F /IM wslhost.exe 2>$null | Out-Null }
    Start-Sleep -Seconds 3

    if (Invoke-WslWakeUp -DistroName $DistroName -TimeoutSec $TimeoutSec) {
        Write-Ok 'WSL 已恢复响应（重启后端后）'
        return
    }
    throw "WSL 恢复失败：发行版 '$DistroName' 仍无响应。请手动执行 'wsl -d $DistroName' 查看具体报错，或重启 Windows 后重试。"
}

function Get-SanitizedScript {
    <#
        把 deploy_wsl.sh 复制一份并剥掉 CR：
        Windows 编辑器 / git 可能把它变成 CRLF，bash 会因 '\r' 直接报语法错误。
        同时以 UTF-8 无 BOM 写出，避免 bash 把 BOM 当成命令的一部分。
    #>
    param([Parameter(Mandatory)][string]$SourceScript, [Parameter(Mandatory)][string]$TargetScript)
    $text = [System.IO.File]::ReadAllText($SourceScript)
    $normalized = $text -replace "`r`n", "`n" -replace "`r", "`n"
    if ($normalized.Length -gt 0 -and $normalized[0] -eq [char]0xFEFF) {
        $normalized = $normalized.Substring(1)
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($TargetScript, $normalized, $utf8NoBom)
    return $TargetScript
}

function Test-WindowsHealth {
    param([int]$TargetPort)
    # 仅作补充信息：Windows 侧 localhost 可能被 wslrelay 遮蔽，失败不代表部署失败
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$TargetPort/api/health" -UseBasicParsing -TimeoutSec 5
        Write-Ok "Windows 侧可访问 http://localhost:$TargetPort/api/health -> $($resp.Content)"
        return $true
    }
    catch {
        Write-Warn2 "Windows 侧访问 http://localhost:$TargetPort/api/health 失败。WSL 内健康检查已通过，通常是 wslrelay/localhost 遮蔽所致；若浏览器能打开则可忽略。"
        return $false
    }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

if ($Help) {
    Show-Usage
    return
}

Write-Host '==============================================================' -ForegroundColor Cyan
Write-Host ' EvolutionWorld - 本机 WSL2 直接部署（不走 GitHub 自托管流程）' -ForegroundColor Cyan
Write-Host '==============================================================' -ForegroundColor Cyan

if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw '未找到 wsl 命令：请先安装并启用 WSL2（wsl --install）。'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $RepoRoot)) { throw "仓库根目录不存在: $RepoRoot" }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).ProviderPath

$deployScript = Join-Path $RepoRoot 'deploy\deploy_wsl.sh'
if (-not (Test-Path -LiteralPath $deployScript)) { throw "缺少部署脚本: $deployScript" }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'server\CMakeLists.txt'))) {
    throw "$RepoRoot 不像 EvolutionWorld 仓库（缺少 server\CMakeLists.txt）"
}

$wslRepo = ConvertTo-WslPath -WindowsPath $RepoRoot
Write-Step "仓库 (Windows) : $RepoRoot"
Write-Step "仓库 (WSL)     : $wslRepo"
Write-Step "发行版         : $Distro"
Write-Step "部署目录       : $Dest"
Write-Step "端口           : $Port"

# ---- 1. 唤醒 WSL ----
Write-Title '=== [1/4] 唤醒并检查 WSL ==='
# 先做一次快速探活：WSL 已就绪时几秒内返回，不必每次都等冷启动超时
Write-Step "快速探活（上限 ${ProbeTimeoutSec}s）"
$wslReady = $false
try {
    $wslReady = Invoke-WslWakeUp -DistroName $Distro -TimeoutSec $ProbeTimeoutSec
}
catch {
    Write-Warn2 $_.Exception.Message
}

if (-not $wslReady) {
    if ($SkipWslRecover) {
        throw "WSL 发行版 '$Distro' 无响应。已指定 -SkipWslRecover，不做自动恢复。"
    }
    if (Test-WslVmAlive) {
        Write-Warn2 'WSL 虚拟机在运行但探活超时：判定为残留客户端阻塞会话，执行分级恢复（通常几秒完成）'
        Restore-WslSession -DistroName $Distro -TimeoutSec $WarmupTimeoutSec -Force:$ForceWslReset
    }
    else {
        Write-Step "WSL 虚拟机未运行，冷启动 provisioning 中（实测可能需 1-3 分钟，上限 ${WarmupTimeoutSec}s，期间不会清理任何进程）"
        try {
            $wslReady = Invoke-WslWakeUp -DistroName $Distro -TimeoutSec $WarmupTimeoutSec
        }
        catch {
            Write-Warn2 $_.Exception.Message
        }
        if (-not $wslReady) {
            Restore-WslSession -DistroName $Distro -TimeoutSec $WarmupTimeoutSec -Force:$ForceWslReset
        }
    }
}
Write-Ok "WSL '$Distro' 已就绪"

# ---- 2. 准备 WSL 内执行的脚本（剥 CR）----
Write-Title '=== [2/4] 准备部署脚本 ==='
$localScript = Join-Path $RepoRoot 'deploy\.deploy_wsl.local.sh'
Get-SanitizedScript -SourceScript $deployScript -TargetScript $localScript | Out-Null
$wslScript = ConvertTo-WslPath -WindowsPath $localScript
Write-Ok "已生成 LF 副本: $wslScript"

# ---- 3. 组装参数并在 WSL 内执行 ----
Write-Title '=== [3/4] 在 WSL 内执行构建与部署 ==='
$wslArgs = @('-d', $Distro, '--', 'bash', $wslScript,
    '--src', $wslRepo, '--dest', $Dest, '--port', "$Port", '--log', $LogFile)
if ($Clean)     { $wslArgs += '--clean' }
if ($SkipBuild) { $wslArgs += '--skip-build' }
if ($NoStart)   { $wslArgs += '--no-start' }
if ($StopOnly)  { $wslArgs += '--stop-only' }
if ($Status)    { $wslArgs += '--status' }
if ($WipeData)  { $wslArgs += '--wipe-data' }
if ($NoDb)      { $wslArgs += '--no-db' }
elseif (-not ($Status -or $StopOnly)) {
    # 仅在用户显式覆盖时才下发：deploy_wsl.sh 内置了与 CI 一致的默认值，
    # 不传可避免默认密码出现在 WSL 内 ps 的命令行里
    if ($PSBoundParameters.ContainsKey('MysqlUser')) { $wslArgs += @('--mysql-user', $MysqlUser) }
    if ($PSBoundParameters.ContainsKey('MysqlPass')) { $wslArgs += @('--mysql-pass', $MysqlPass) }
    if ($PSBoundParameters.ContainsKey('MysqlDb'))   { $wslArgs += @('--mysql-db', $MysqlDb) }
}

# 查询/停止类操作不需要完整构建时长，但仍要能覆盖偶发的 WSL 冷启动
$invokeTimeout = $BuildTimeoutSec
if ($Status -or $StopOnly -or $SkipBuild -or $NoStart) {
    $invokeTimeout = [Math]::Min($ShortTimeoutSec, $BuildTimeoutSec)
}
Write-Step "本次操作超时上限: ${invokeTimeout}s"

$exitCode = Invoke-WslJob -WslArgs $wslArgs -TimeoutSec $invokeTimeout -Label 'WSL 部署' -CaptureExitCode

# ---- 4. 结果确认 ----
Write-Title '=== [4/4] 部署结果 ==='
if ($exitCode -ne 0) {
    throw "部署失败：WSL 内脚本退出码 $exitCode（详见上方输出）。"
}

if ($Status -or $StopOnly -or $NoStart) {
    Write-Ok '操作完成（退出码 0）'
    return
}

if (-not $NoWindowsHealthCheck) { Test-WindowsHealth -TargetPort $Port | Out-Null }

Write-Host ''
Write-Host '==============================================================' -ForegroundColor Green
Write-Host " 部署成功：浏览器打开 http://localhost:$Port 即可测试最新构建" -ForegroundColor Green
Write-Host ' 停止服务：powershell -File deploy\deploy-local.ps1 -StopOnly' -ForegroundColor Green
Write-Host ' 查看状态：powershell -File deploy\deploy-local.ps1 -Status' -ForegroundColor Green
Write-Host '==============================================================' -ForegroundColor Green
