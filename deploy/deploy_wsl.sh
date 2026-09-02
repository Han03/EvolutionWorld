#!/usr/bin/env bash
# ============================================================================
# deploy_wsl.sh —— EvolutionWorld 本机 WSL2 直接部署（第二种部署方式）
#
# 不经过 GitHub push / 自托管 runner，直接在本机 WSL2 Ubuntu 内完成：
#   构建 C++ 服务端 -> 停旧进程 -> 部署产物到 /opt -> 启动 -> 健康检查
#
# 通常由 Windows 侧的 deploy/deploy-local.ps1 调用；也可在 WSL 内手动执行：
#   bash deploy/deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld
#
# 约定：
#   1. 运行时输出一律使用 ASCII —— Windows 控制台代码页（如 gb2312）解码 WSL 的
#      UTF-8 输出会乱码，中文只出现在注释里。
#   2. 进程管理完全绕开 systemd（systemctl 在 WSL2 多会话下会因 D-Bus 争用挂死），
#      统一用 pkill -9 停止、nohup + disown 启动。
#   3. 默认保留 /opt/evolutionworld/server/data 运行时数据（账号 users.json、
#      地形编辑 terrain_edit.json、出生点 spawns.json），与 CI 的整目录 rm -rf 不同。
# ============================================================================
set -uo pipefail

# ---- 默认配置 ----
SRC=""
DEST="/opt/evolutionworld"
PORT="3000"
CLEAN=0
SKIP_BUILD=0
NO_START=0
STOP_ONLY=0
STATUS_ONLY=0
WIPE_DATA=0
NO_DB=0
MYSQL_USER="root"
MYSQL_PASS="123456"
MYSQL_DB="evolution_world"
LOG_FILE="/tmp/evolution_server.log"
HEALTH_TRIES=20
HEALTH_INTERVAL=3

# ---- 日志（ASCII）----
step() { printf '\n=== %s ===\n' "$*"; }
log()  { printf '[deploy] %s\n' "$*"; }
ok()   { printf '[  OK  ] %s\n' "$*"; }
warn() { printf '[ WARN ] %s\n' "$*" >&2; }
fail() { printf '[ FAIL ] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy_wsl.sh --src <repo path in WSL> [options]

Options:
  --src <path>       Repo root as seen from WSL (e.g. /mnt/c/MyProjects/EvolutionWorld)
  --dest <path>      Deploy target dir (default /opt/evolutionworld)
  --port <n>         Server port, injected as EW_PORT (default 3000)
  --clean            Wipe build dir for a full rebuild (default: incremental, faster)
  --skip-build       Reuse existing build output, only redeploy + restart
  --no-start         Build and deploy, but do not start the server
  --stop-only        Stop the running server and exit
  --status           Show deployment / runtime status and exit
  --wipe-data        Also wipe runtime data (accounts, terrain edits, spawns)
  --no-db            Do not inject MySQL/Redis config (pure in-memory mode)
  --mysql-user <u>   MySQL user (default root)
  --mysql-pass <p>   MySQL password (default 123456)
  --mysql-db <db>    MySQL database (default evolution_world)
  --log <path>       Server log file (default /tmp/evolution_server.log)
  -h, --help         Show this help

Examples:
  bash deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld
  bash deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld --clean
  bash deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld --skip-build
  bash deploy_wsl.sh --src /mnt/c/MyProjects/EvolutionWorld --status
EOF
}

need_val() {
  if [ -z "${2:-}" ]; then
    printf '[ FAIL ] option %s requires a value\n' "$1" >&2
    usage >&2
    exit 2
  fi
}

# ---- 参数解析 ----
while [ $# -gt 0 ]; do
  case "$1" in
    --src)         need_val "$1" "${2:-}"; SRC="$2";          shift 2 ;;
    --dest)        need_val "$1" "${2:-}"; DEST="$2";         shift 2 ;;
    --port)        need_val "$1" "${2:-}"; PORT="$2";         shift 2 ;;
    --mysql-user)  need_val "$1" "${2:-}"; MYSQL_USER="$2";   shift 2 ;;
    --mysql-pass)  need_val "$1" "${2:-}"; MYSQL_PASS="$2";   shift 2 ;;
    --mysql-db)    need_val "$1" "${2:-}"; MYSQL_DB="$2";     shift 2 ;;
    --log)         need_val "$1" "${2:-}"; LOG_FILE="$2";     shift 2 ;;
    --clean)       CLEAN=1;       shift ;;
    --skip-build)  SKIP_BUILD=1;  shift ;;
    --no-start)    NO_START=1;    shift ;;
    --stop-only)   STOP_ONLY=1;   shift ;;
    --status)      STATUS_ONLY=1; shift ;;
    --wipe-data)   WIPE_DATA=1;   shift ;;
    --no-db)       NO_DB=1;       shift ;;
    -h|--help)     usage; exit 0 ;;
    *) printf '[ FAIL ] unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---- 解析源码目录（未显式指定时按脚本自身位置推导，便于在 WSL 内手动执行）----
if [ -z "$SRC" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  SRC="$(dirname "$SCRIPT_DIR")"
fi
SRC="${SRC%/}"
DEST="${DEST%/}"

# 运行时数据文件：部署时不得覆盖（由服务端在线编辑/落盘产生）
RUNTIME_DATA_FILES="users.json terrain_edit.json spawns.json"
# 纯配置文件：仓库里存在则同步过去（服务端有内置兜底，缺失不影响功能）
CONFIG_DATA_FILES="items.json monsters.json shop.json skills.json"

preflight_src() {
  [ -d "$SRC" ] || fail "source dir not found: $SRC"
  [ -f "$SRC/server/CMakeLists.txt" ] || fail "not an EvolutionWorld repo (missing server/CMakeLists.txt): $SRC"
  [ -d "$SRC/client" ] || fail "client dir missing: $SRC/client"
}

# ---- Windows 主机 IP：WSL2 重启后会变，必须每次动态解析 ----
resolve_win_host() {
  # 用 cut 而非 awk，避免 PowerShell -> WSL 传参时 $2 被转义吃掉
  grep nameserver /etc/resolv.conf 2>/dev/null | head -1 | cut -d' ' -f2 | tr -d '\r'
}

# ---- 状态查询 ----
show_status() {
  step "Deployment status"
  log "source : $SRC"
  log "dest   : $DEST"
  log "port   : $PORT"

  printf '\n--- deployed tree ---\n'
  if [ -d "$DEST" ]; then
    ls -la "$DEST" 2>/dev/null
  else
    log "not deployed yet: $DEST"
  fi

  printf '\n--- binary ---\n'
  if [ -f "$DEST/server/build/evolution_server" ]; then
    ls -la "$DEST/server/build/evolution_server"
  else
    log "binary not found: $DEST/server/build/evolution_server"
  fi

  printf '\n--- process ---\n'
  ps aux | grep -F evolution_server | grep -v grep || log "server not running"

  printf '\n--- port %s ---\n' "$PORT"
  ss -tlnp 2>/dev/null | grep ":$PORT " || log "port $PORT not listening"

  printf '\n--- health ---\n'
  curl -sf --max-time 3 "http://localhost:$PORT/api/health" && printf '\n' || log "health endpoint not responding"

  printf '\n--- runtime data (%s/server/data) ---\n' "$DEST"
  ls -la "$DEST/server/data" 2>/dev/null || log "no data dir"
  printf '\n'
}

# ---- 停止旧进程（SIGKILL + 双重 kill + 等端口释放）----
stop_server() {
  step "Stopping old server"
  # 部分进程会忽略 SIGTERM，统一 -9；kill 后等待 1s 再补一刀
  pkill -9 -f evolution_server 2>/dev/null || true
  fuser -k "$PORT/tcp" 2>/dev/null || true
  sleep 1
  pkill -9 -f evolution_server 2>/dev/null || true

  local i
  for i in $(seq 1 10); do
    if ! ss -tln 2>/dev/null | grep -q ":$PORT "; then
      ok "port $PORT is free (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  warn "port $PORT still in use after 10s"
  ss -tlnp 2>/dev/null | grep ":$PORT " || true
  return 1
}

# ---- 构建 ----
build_server() {
  step "Building C++ server in WSL"
  command -v cmake >/dev/null 2>&1 || fail "cmake not found (sudo apt install cmake)"
  command -v g++   >/dev/null 2>&1 || fail "g++ not found (sudo apt install g++)"

  local jobs
  jobs="$(nproc 2>/dev/null || echo 4)"
  log "compiler : $(g++ --version 2>/dev/null | head -1)"
  log "cmake    : $(cmake --version 2>/dev/null | head -1)"
  log "parallel : -j$jobs"

  if [ "$CLEAN" = "1" ] && [ -d "$SRC/server/build" ]; then
    log "--clean: removing $SRC/server/build"
    rm -rf "$SRC/server/build" || fail "cannot remove build dir"
  else
    log "incremental build (use --clean for a full rebuild)"
  fi

  log "cmake configure (Release)"
  ( cd "$SRC/server" && cmake -B build -DCMAKE_BUILD_TYPE=Release ) || fail "cmake configure failed"

  log "cmake build"
  ( cd "$SRC/server" && cmake --build build -j "$jobs" ) || fail "cmake build failed"

  [ -f "$SRC/server/build/evolution_server" ] || fail "build produced no binary: $SRC/server/build/evolution_server"
  ok "build succeeded"
  ls -la "$SRC/server/build/evolution_server"
}

# ---- 部署产物 ----
deploy_artifacts() {
  step "Deploying artifacts to $DEST"
  mkdir -p "$DEST/server/build" || fail "cannot create $DEST/server/build (permission denied?)"

  # 客户端静态资源整目录替换，避免已删除文件残留
  log "client : $SRC/client -> $DEST/client"
  rm -rf "$DEST/client" || fail "cannot remove $DEST/client"
  cp -r "$SRC/client" "$DEST/client" || fail "failed to copy client"

  # 服务端二进制
  log "binary : $SRC/server/build/evolution_server -> $DEST/server/build/"
  cp -f "$SRC/server/build/evolution_server" "$DEST/server/build/evolution_server" || fail "failed to copy binary"
  chmod +x "$DEST/server/build/evolution_server" || fail "chmod failed"

  # 运行时数据（账号 / 地形编辑 / 出生点）
  if [ "$WIPE_DATA" = "1" ]; then
    warn "--wipe-data: removing $DEST/server/data (accounts and editor saves will be lost)"
    rm -rf "$DEST/server/data" || fail "cannot wipe data dir"
  fi
  mkdir -p "$DEST/server/data" || fail "cannot create data dir"

  if [ "$WIPE_DATA" != "1" ]; then
    local kept=""
    local f
    for f in $RUNTIME_DATA_FILES; do
      [ -f "$DEST/server/data/$f" ] && kept="$kept $f"
    done
    if [ -n "$kept" ]; then
      ok "runtime data preserved:$kept"
    else
      log "runtime data dir is empty (fresh deployment)"
    fi
  fi

  # 仓库中的纯配置文件按需同步（跳过运行时状态文件，不覆盖线上编辑结果）
  if [ -d "$SRC/server/data" ]; then
    local cf
    for cf in $CONFIG_DATA_FILES; do
      if [ -f "$SRC/server/data/$cf" ]; then
        log "config : data/$cf"
        cp -f "$SRC/server/data/$cf" "$DEST/server/data/$cf" || warn "failed to copy data/$cf"
      fi
    done
  fi
  ok "artifacts deployed"
}

# ---- 启动（两阶段：先前台探错，再后台常驻）----
start_server() {
  step "Starting server"

  local -a env_args=(EW_DEBUG=1 "EW_PORT=$PORT")
  if [ "$NO_DB" = "1" ]; then
    log "--no-db: skipping MySQL/Redis config (pure in-memory mode)"
  else
    local win_host ew_config
    win_host="$(resolve_win_host)"
    if [ -n "$win_host" ]; then
      ew_config="mysql_host=$win_host,mysql_port=3306,mysql_user=$MYSQL_USER,mysql_pass=$MYSQL_PASS,mysql_db=$MYSQL_DB,redis_host=$win_host,redis_port=6379"
      log "windows host IP (from WSL2 /etc/resolv.conf): $win_host"
      log "EW_CONFIG: $ew_config"
      env_args+=("EW_CONFIG=$ew_config")
    else
      warn "cannot resolve Windows host IP from /etc/resolv.conf; starting without DB config"
    fi
  fi

  # 阶段一：前台跑 5s。WSL 下后台进程若在 shell 初始化期崩溃，日志往往来不及落盘，
  #         先前台运行可把崩溃原因直接打到控制台。
  log "stage 1/2: foreground probe (5s) to surface startup crashes"
  local probe_out
  probe_out="$(cd "$DEST/server" && env "${env_args[@]}" timeout 5 ./build/evolution_server 2>&1)"
  printf -- '--- startup output (first 5s) ---\n'
  if [ -n "$probe_out" ]; then printf '%s\n' "$probe_out"; else printf '(no output)\n'; fi
  printf -- '--- end startup output ---\n'

  # 探测进程被 timeout 杀掉后，等端口释放再真正启动
  local i
  for i in $(seq 1 8); do
    ss -tln 2>/dev/null | grep -q ":$PORT " || break
    sleep 1
  done

  # 阶段二：nohup + disown 常驻（CI 已验证该组合能在 wsl 会话退出后存活）
  log "stage 2/2: background start, log -> $LOG_FILE"
  ( cd "$DEST/server" && env "${env_args[@]}" nohup ./build/evolution_server > "$LOG_FILE" 2>&1 & disown; sleep 1 )
  sleep 2

  SERVER_PID="$(pgrep -f "$DEST/server/build/evolution_server" 2>/dev/null | head -1)"
  if [ -n "${SERVER_PID:-}" ]; then
    ok "server started, pid=$SERVER_PID"
  else
    warn "server process not detected yet, relying on health check"
  fi
}

# ---- 健康检查（在 WSL 内 curl，绕开 Windows 侧 wslrelay/localhost 遮蔽问题）----
health_check() {
  step "Health check"
  local i out
  for i in $(seq 1 "$HEALTH_TRIES"); do
    out="$(curl -sf --max-time 3 "http://localhost:$PORT/api/health" 2>/dev/null || true)"
    case "$out" in
      *'"ok":true'*|*'"ok": true'*)
        ok "health OK on try $i: $out"
        return 0
        ;;
    esac
    sleep "$HEALTH_INTERVAL"
  done

  warn "health check FAILED after ~$((HEALTH_TRIES * HEALTH_INTERVAL))s"
  printf -- '--- server log (%s) ---\n' "$LOG_FILE"
  tail -n 60 "$LOG_FILE" 2>/dev/null || printf '(no log file)\n'
  printf -- '--- process ---\n'
  ps aux | grep -F evolution_server | grep -v grep || printf '(no server process)\n'
  printf -- '--- port %s ---\n' "$PORT"
  ss -tlnp 2>/dev/null | grep ":$PORT " || printf '(port not listening)\n'
  printf -- '--- missing shared libs ---\n'
  ldd "$DEST/server/build/evolution_server" 2>&1 | grep "not found" || printf '(all libs resolved)\n'
  return 1
}

summary() {
  printf '\n==============================================================\n'
  printf ' DEPLOY OK (local WSL, no GitHub Actions involved)\n'
  printf '--------------------------------------------------------------\n'
  printf ' binary : %s/server/build/evolution_server\n' "$DEST"
  printf ' pid    : %s\n' "${SERVER_PID:-unknown}"
  printf ' url    : http://localhost:%s\n' "$PORT"
  printf ' log    : %s\n' "$LOG_FILE"
  printf ' client : %s/client\n' "$DEST"
  printf ' data   : %s/server/data\n' "$DEST"
  printf '--------------------------------------------------------------\n'
  printf ' stop   : powershell -File deploy/deploy-local.ps1 -StopOnly\n'
  printf ' status : powershell -File deploy/deploy-local.ps1 -Status\n'
  printf '==============================================================\n'
}

# ---- 主流程 ----
printf '==============================================================\n'
printf ' EvolutionWorld - local WSL2 deployment\n'
printf '==============================================================\n'
log "user   : $(whoami 2>/dev/null || echo unknown)"
log "kernel : $(uname -r 2>/dev/null)"

preflight_src

if [ "$STATUS_ONLY" = "1" ]; then
  show_status
  exit 0
fi

if [ "$STOP_ONLY" = "1" ]; then
  stop_server || true
  ok "server stopped"
  exit 0
fi

if [ "$SKIP_BUILD" = "1" ]; then
  step "Skipping build (--skip-build)"
  [ -f "$SRC/server/build/evolution_server" ] || fail "no binary at $SRC/server/build/evolution_server - run once without --skip-build"
  ls -la "$SRC/server/build/evolution_server"
else
  build_server
fi

stop_server || warn "continuing, but the new server may fail to bind port $PORT"

deploy_artifacts

if [ "$NO_START" = "1" ]; then
  ok "build + deploy finished, server NOT started (--no-start)"
  exit 0
fi

start_server

if health_check; then
  summary
  exit 0
fi

fail "deployment finished but the server is not healthy - see diagnostics above"
