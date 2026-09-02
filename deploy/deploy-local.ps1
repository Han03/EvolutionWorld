<#
.SYNOPSIS
    EvolutionWorld 本机 WSL2 直接部署（第二种部署方式，不走 GitHub 自托管 runner）。

.DESCRIPTION
    在 Windows 侧编排、在 WSL2 Ubuntu 内执行构建与部署：
      探活 WSL -> (必要时分级恢复) -> 调用 deploy/deploy_wsl.sh -> 构建 -> 停旧进程
      -> 部署到 /opt/evolutionworld -> 启动 -> 健康检查

    与 CI（.github/workflows/ci.yml）的差异：
      * 代码来源为本地工作副本，无需 git push / runner 领取任务；
      * 默认增量构建（CI 每次 rm -rf build 全量重建），可用 -Clean 强制全量；
      * 默认保留 /opt/evolutionworld/server/data 运行时数据（账号 / 地形编辑 /
        出生点），CI 会整目录删除；-WipeData 可对齐 CI 行为。

    输出编码约定：WSL 侧脚本只输出 ASCII，PowerShell 侧输出中文。
    本机控制台代码页为 gb2312，若强行把 Console 编码切成 UTF-8 反而会让中文乱码，
    故此处不修改 [Console]::OutputEncoding。

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
    [int]$ProbeTimeoutSec = 20,
    [switch]$SkipWslRecover,
    [switch]$ForceWslReset,
    [switch]$NoWindowsHealthCheck,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
# WSL 命令的退出码经由输出标记回传（后台作业里读不到 $LASTEXITCODE）
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
  -WipeData               同时清空运行时数据（账号 / 地形编辑 / 出生点）
  -NoDb                   不注入 MySQL/Redis 配置（纯内存模式）
  -MysqlUser <u>          MySQL 用户（默认 root）
  -MysqlPass <p>          MySQL 密码（默认 123456）
  -MysqlDb <db>           MySQL 库名（默认 evolution_world）
  -LogFile <path>         WSL 内服务日志路径（默认 /tmp/evolution_server.log）
  -BuildTimeoutSec <n>    WSL 部署命令整体超时（默认 1800 秒）
  -ProbeTimeoutSec <n>    WSL 探活超时（默认 20 秒）
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

function Clear-HungWslClients {
    # 探测超时残留的 wsl.exe 客户端会成为下一次调用的阻塞源，必须清掉
    $stale = @(Get-Process -Name wsl -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) {
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Step "已结束 $($stale.Count) 个残留的 wsl.exe 客户端进程"
        Start-Sleep -Seconds 2
    }
}

function Invoke-Wsl {
    <#
        在后台作业里执行 wsl 命令：既能边跑边把输出流式打到控制台，
        又能用超时兜住 WSL 挂死（直接前台调用会无限期阻塞）。
    #>
    param(
        [Parameter(Mandatory)][string[]]$WslArgs,
        [int]$TimeoutSec = 1800,
        [string]$Label = 'wsl command'
    )
    $script:EwExitCode = $null
    $job = Start-Job -ScriptBlock {
        param($args, $marker)
        & wsl @args 2>&1 | ForEach-Object { [string]$_ }
        "$marker$LASTEXITCODE"
    } -ArgumentList @(, $WslArgs), $script:EwExitMarker

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
                Clear-HungWslClients
                throw "$Label 超时（已运行 $([int]$sw.Elapsed.TotalSeconds)s，上限 ${TimeoutSec}s）。WSL 可能已挂死，可重试或加 -ForceWslReset。"
            }
        }
    }
    finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }

    if ($null -eq $script:EwExitCode) {
        Write-Warn2 "未能取得 $Label 的退出码，按失败处理"
        return 1
    }
    return $script:EwExitCode
}

function Test-WslReady {
    param([string]$DistroName, [int]$TimeoutSec = 20)
    $job = Start-Job -ScriptBlock {
        param($d)
        & wsl -d $d -- bash -c 'echo WSL_READY' 2>&1 | ForEach-Object { [string]$_ }
    } -ArgumentList $DistroName

    $ready = $false
    if (Wait-Job -Job $job -Timeout $TimeoutSec) {
        $out = (Receive-Job -Job $job -ErrorAction SilentlyContinue) -join "`n"
        if ($out -match 'WSL_READY') { $ready = $true }
    }
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    if (-not $ready) { Clear-HungWslClients }
    return $ready
}

function Restore-WslSession {
    <#
        WSL 无响应时的分级恢复。注意不要用 wsl --shutdown：
        它是优雅关闭，有用户会话时会无限期挂死。
    #>
    param([string]$DistroName, [int]$TimeoutSec = 20, [switch]$Force)

    if (-not $Force) {
        Write-Title '=== WSL 无响应，分级恢复 ==='
        Write-Warn2 '阶段 1/2：结束挂死的 wsl.exe 客户端进程（已打开的 WSL 终端可能被关闭）'
        Clear-HungWslClients
        Start-Sleep -Seconds 2
        if (Test-WslReady -DistroName $DistroName -TimeoutSec $TimeoutSec) {
            Write-Ok 'WSL 已恢复响应（仅需清理客户端进程）'
            return
        }
    }

    Write-Warn2 '阶段 2/2：在 Windows 层强制重启 WSL 后端（wslservice / wslhost），WSL 内正在运行的服务会一并终止'
    Get-Process -Name wslservice, wslhost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    & taskkill /F /IM wslservice.exe 2>$null | Out-Null
    & taskkill /F /IM wslhost.exe 2>$null | Out-Null
    Start-Sleep -Seconds 3

    if (Test-WslReady -DistroName $DistroName -TimeoutSec 40) {
        Write-Ok 'WSL 已恢复响应（重启后端后）'
        return
    }
    throw "WSL 恢复失败：发行版 '$DistroName' 仍无响应。请手动执行 'wsl -d $DistroName' 检查，或重启 Windows 后重试。"
}

function Get-SanitizedScript {
    <#
        把 deploy_wsl.sh 复制一份并剥掉 CR：
        Windows 编辑器/git 可能把它变成 CRLF，bash 会因 '\r' 直接报语法错误。
    #>
    param([Parameter(Mandatory)][string]$SourceScript, [Parameter(Mandatory)][string]$TargetScript)
    $text = [System.IO.File]::ReadAllText($SourceScript)
    $normalized = $text -replace "`r`n", "`n" -replace "`r", "`n"
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
        Write-Warn2 "Windows 侧访问 http://localhost:$TargetPort/api/health 失败（WSL 内健康检查已通过，通常是 wslrelay/localhost 遮蔽，不影响浏览器访问时可忽略）"
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
Write-Host ' EvolutionWorld · 本机 WSL2 直接部署（不走 GitHub 自托管流程）' -ForegroundColor Cyan
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

# ---- 1. WSL 探活 ----
Write-Title '=== [1/4] 检查 WSL 可用性 ==='
if (-not (Test-WslReady -DistroName $Distro -TimeoutSec $ProbeTimeoutSec)) {
    if ($SkipWslRecover) {
        throw "WSL 发行版 '$Distro' 在 ${ProbeTimeoutSec}s 内无响应。已指定 -SkipWslRecover，不做自动恢复。"
    }
    Restore-WslSession -DistroName $Distro -TimeoutSec $ProbeTimeoutSec -Force:$ForceWslReset
}
else {
    Write-Ok "WSL '$Distro' 响应正常"
}

# ---- 2. 准备 WSL 内执行的脚本（剥 CR）----
Write-Title '=== [2/4] 准备部署脚本 ==='
$localScript = Join-Path $RepoRoot 'deploy\.deploy_wsl.local.sh'
Get-SanitizedScript -SourceScript $deployScript -TargetScript $localScript | Out-Null
$wslScript = ConvertTo-WslPath -WindowsPath $localScript
Write-Ok "已生成 LF 版本: $wslScript"

# ---- 3. 组装参数并在 WSL 内执行 ----
Write-Title '=== [3/4] 在 WSL 内执行构建与部署 ==='
$wslArgs = @('-d', $Distro, '--', 'bash', $wslScript, '--src', $wslRepo, '--dest', $Dest, '--port', "$Port", '--log', $LogFile)
if ($Clean)      { $wslArgs += '--clean' }
if ($SkipBuild)  { $wslArgs += '--skip-build' }
if ($NoStart)    { $wslArgs += '--no-start' }
if ($StopOnly)   { $wslArgs += '--stop-only' }
if ($Status)     { $wslArgs += '--status' }
if ($WipeData)   { $wslArgs += '--wipe-data' }
if ($NoDb)       { $wslArgs += '--no-db' }
if (-not $NoDb)  { $wslArgs += @('--mysql-user', $MysqlUser, '--mysql-pass', $MysqlPass, '--mysql-db', $MysqlDb) }

# 纯查询/停止类操作无需给足构建时长
$invokeTimeout = $BuildTimeoutSec
if ($Status -or $StopOnly) { $invokeTimeout = [Math]::Min(120, $BuildTimeoutSec) }
elseif ($SkipBuild -or $NoStart) { $invokeTimeout = [Math]::Min(600, $BuildTimeoutSec) }

$exitCode = Invoke-Wsl -WslArgs $wslArgs -TimeoutSec $invokeTimeout -Label 'WSL 部署'

# ---- 4. 结果确认 ----
Write-Title '=== [4/4] 部署结果 ==='
if ($exitCode -ne 0) {
    throw "部署失败：WSL 内脚本退出码 $exitCode（详见上方输出）。"
}

if ($Status -or $StopOnly -or $NoStart) {
    Write-Ok "操作完成（退出码 0）"
    return
}

if (-not $NoWindowsHealthCheck) { Test-WindowsHealth -TargetPort $Port | Out-Null }

Write-Host ''
Write-Host '==============================================================' -ForegroundColor Green
Write-Host ' 部署成功：浏览器打开 http://localhost:'"$Port"' 即可测试最新构建' -ForegroundColor Green
Write-Host " 停止服务：powershell -File deploy\deploy-local.ps1 -StopOnly" -ForegroundColor Green
Write-Host " 查看状态：powershell -File deploy\deploy-local.ps1 -Status" -ForegroundColor Green
Write-Host '==============================================================' -ForegroundColor Green
