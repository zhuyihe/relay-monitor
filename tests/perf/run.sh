#!/usr/bin/env bash
# 对拍和「接口和后台」性能实测的编排。CI（.github/workflows/perf.yml）一步一个子命令，本机用 local 一条命令跑完。
#
#   run.sh local <base 提交> <head 提交>   本机：两个提交各检出到 $PERF_OUT/apps/<sha>、npm ci、next build（同一提交只打一次），再跑 all
#   run.sh all                             seed → measure base → parity → measure head → compare（要先设好 PERF_BASE_DIR、PERF_HEAD_DIR）
#   run.sh seed                            建夹具（用 base 的代码）：删库重建、接入 50 个上游 80 条绑定、灌余额历史、结账 RECON_DAYS 天
#   run.sh measure <标签> <应用目录>       起服务，量接口（冷 1 次 + API_N 次）和后台（稳态 BG_SEC 秒），再出数据库统计，结果在 $PERF_OUT/<标签>/
#   run.sh parity                          对拍：最近 PARITY_DAYS 天的账本挪走，base、head 各结一遍再比，结果在 $PERF_OUT/parity/
#   run.sh compare                         $PERF_OUT/compare.md（base 对 head）；有超线退出码 2
#   run.sh stop                            关掉这里起的服务和假站点
#
# 环境变量（默认值）：DB_HOST(127.0.0.1) DB_PORT(3306) DB_USER(root) DB_PASSWORD() DB_NAME(relay_monitor_perf，名字里必须带 perf，种子会删库重建)
#   APP_PORT(3301) FAKE_PORT(18950) FAKE_OWN_PORT(FAKE_PORT + 1，假站点里自营站点的端口) PERF_OUT(系统临时目录/relay-monitor-perf) PERF_BASE_DIR PERF_HEAD_DIR（打包好的应用目录）
#   PARITY_DAYS(14) API_N(10) BG_SEC(185) RECON_DAYS(90) PERF_HISTORY_DAYS(90) FAKE_DELAY_MS(50) FAKE_TEST_LOGS(0，假站点开关，见 README)
#   PERF_BINDINGS(空 = 80 条绑定；缩小夹具，种子、假站点、测量一起用) PERF_EXPECTED_COST(off；on 时后台测量前打开「算应付成本」整站读)
#   PERF_STEADY_DELAY_SEC(0，量完接口以后先等这么多秒再开稳态，量「没人看」用 660；BG_SEC 就是 workflow 的 steady_sec)
#   PERF_KEY_AGENT(off；on 时假站点在 https 端口 FAKE_KEY_AGENT_PORT(FAKE_PORT + 2) 装渠道 Key 读取服务、自营站点配上地址和令牌，
#     证书 $PERF_OUT/tls/key-agent.crt 现生成，被测应用带 NODE_EXTRA_CA_CERTS；对拍时暂停换 Key。见 README「K2a/K2b 场景」)
#   PERF_KEY_AGENT_ROTATE_SEC(600；假读取服务换一次 Key 的间隔，稳态窗口只有 185 秒，想量到换 Key 以后重新认、写段就填 60 左右)
# 不带锁：CI 上一台机器只跑这一件。本机和别的重活抢机器时，自己在外面拿锁。

set -o pipefail
PERF_DIR=$(cd "$(dirname "$0")" && pwd)
export DB_HOST=${DB_HOST:-127.0.0.1} DB_PORT=${DB_PORT:-3306} DB_USER=${DB_USER:-root} DB_PASSWORD=${DB_PASSWORD:-} DB_NAME=${DB_NAME:-relay_monitor_perf}
export APP_PORT=${APP_PORT:-3301} FAKE_PORT=${FAKE_PORT:-18950}
export FAKE_OWN_PORT=${FAKE_OWN_PORT:-$(( FAKE_PORT + 1 ))} FAKE_KEY_AGENT_PORT=${FAKE_KEY_AGENT_PORT:-$(( FAKE_PORT + 2 ))}
TMP_ROOT=${TMPDIR:-/tmp}
export PERF_OUT=${PERF_OUT:-${TMP_ROOT%/}/relay-monitor-perf}
PARITY_DAYS=${PARITY_DAYS:-14} API_N=${API_N:-10} BG_SEC=${BG_SEC:-185} RECON_DAYS=${RECON_DAYS:-90}
LOGS=$PERF_OUT/logs
mkdir -p "$LOGS" "$PERF_OUT/pids"

case "$DB_NAME" in *perf*) ;; *) echo "DB_NAME=$DB_NAME：性能夹具只用名字里带 perf 的库（种子会删库重建）"; exit 1 ;; esac

progress() { echo "$(date '+%Y/%m/%d %H:%M:%S') $*" | tee -a "$PERF_OUT/progress.log"; }
now_s() { date +%s; }
# 每一段的用时记在 $PERF_OUT/timings.txt
timed() { local name=$1; shift; local t0; t0=$(now_s); "$@"; local rc=$?; echo "$name $(( $(now_s) - t0 )) 秒 退出码 $rc" >> "$PERF_OUT/timings.txt"; return $rc; }

pids_on_port() {
  { lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null || ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; } | sort -u
}
kill_port() {
  local pids; pids=$(pids_on_port "$1")
  [ -n "$pids" ] && kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(pids_on_port "$1")" ] && return 0; sleep 0.5; done
  pids=$(pids_on_port "$1"); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}

stop_app() {
  [ -f "$PERF_OUT/pids/app" ] && kill "$(cat "$PERF_OUT/pids/app")" 2>/dev/null
  rm -f "$PERF_OUT/pids/app"
  kill_port "$APP_PORT"
  (cd "$PERF_DIR" && PERF_APP_DIR=${CURRENT_APP_DIR:-${PERF_BASE_DIR:-}} node lib/kill-queries.mjs) 2>/dev/null
  return 0
}
stop_fake() {
  [ -f "$PERF_OUT/pids/fake" ] && kill "$(cat "$PERF_OUT/pids/fake")" 2>/dev/null
  rm -f "$PERF_OUT/pids/fake"
  kill_port "$FAKE_PORT"; kill_port "$FAKE_OWN_PORT"; kill_port "$FAKE_KEY_AGENT_PORT"
}
fake_up() { curl -sf -m 2 "http://127.0.0.1:$FAKE_PORT/__health" > /dev/null; }
# 渠道 Key 读取服务的自签证书（PERF_KEY_AGENT=on 时）：CN、SAN 都是 127.0.0.1，放在 $PERF_OUT/tls/；假站点的 https 端口用它，
# 被测应用进程带 NODE_EXTRA_CA_CERTS 信任它（start_app）。不用 NODE_TLS_REJECT_UNAUTHORIZED=0：那样量不到证书这一环
KEY_AGENT_CERT=$PERF_OUT/tls/key-agent.crt
key_agent_on() { case "${PERF_KEY_AGENT:-}" in 1|on|true|ON|TRUE) return 0 ;; *) return 1 ;; esac; }
ensure_cert() {
  key_agent_on || return 0
  [ -s "$KEY_AGENT_CERT" ] && [ -s "$PERF_OUT/tls/key-agent.key" ] && return 0
  mkdir -p "$PERF_OUT/tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
    -keyout "$PERF_OUT/tls/key-agent.key" -out "$KEY_AGENT_CERT" > "$LOGS/openssl.log" 2>&1 \
    || { echo "生成读取服务证书失败，见 $LOGS/openssl.log"; return 1; }
}
ensure_fake() {
  fake_up && return 0
  ensure_cert || return 1
  stop_fake
  (cd "$PERF_DIR" && exec env FAKE_DELAY_MS="${FAKE_DELAY_MS:-50}" node fake-site.mjs >> "$LOGS/fake-site.log" 2>&1) &
  echo $! > "$PERF_OUT/pids/fake"
  for _ in $(seq 1 120); do fake_up && return 0; sleep 0.5; done
  echo "假站点没起来，见 $LOGS/fake-site.log"; return 1
}

# 起打包好的服务：等到 /login 能打开，再请求一次接口触发运行时初始化（连库、载入 Store、读热历史……）
start_app() {
  local dir=$1 label=$2
  stop_app
  [ -f "$dir/.next/BUILD_ID" ] || { echo "$dir 没打包（没有 .next/BUILD_ID）"; return 1; }
  CURRENT_APP_DIR=$dir
  local preload=""
  [ -f "$dir/lib/peer-address.js" ] && preload="--import ./lib/peer-address.js"
  local t0 t1 t2
  t0=$(node -e 'console.log(Date.now())')
  local ca=()
  key_agent_on && ca=(NODE_EXTRA_CA_CERTS="$KEY_AGENT_CERT")
  (cd "$dir" && exec env "${ca[@]}" HOST=127.0.0.1 PORT="$APP_PORT" node $preload node_modules/next/dist/bin/next start -p "$APP_PORT" -H 127.0.0.1 >> "$LOGS/app-$label.log" 2>&1) &
  echo $! > "$PERF_OUT/pids/app"
  local ok=0
  for _ in $(seq 1 240); do
    case $(curl -s -o /dev/null -m 5 -w "%{http_code}" "http://127.0.0.1:$APP_PORT/login") in 2*) ok=1; break ;; esac
    sleep 0.5
  done
  [ $ok = 1 ] || { echo "服务没起来，见 $LOGS/app-$label.log"; tail -30 "$LOGS/app-$label.log"; return 1; }
  t1=$(node -e 'console.log(Date.now())')
  curl -s -o /dev/null -m 180 "http://127.0.0.1:$APP_PORT/api/meta"
  t2=$(node -e 'console.log(Date.now())')
  local pid rss
  pid=$(pids_on_port "$APP_PORT" | head -1)
  rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
  STARTUP_LINE="服务起来 $(( t1 - t0 )) ms，第一次接口（运行时初始化）$(( t2 - t1 )) ms，进程内存 $(( ${rss:-0} / 1024 )) MB"
  progress "启动 $label（$dir）：$STARTUP_LINE"
}

# 等服务起来后的第一轮全量刷新和第一轮结账轮询跑完：假站点 8 秒内没有新请求就算稳了（最多等 150 秒）
warm() {
  local last=-1 same=0 n
  for _ in $(seq 1 75); do
    n=$(curl -s "http://127.0.0.1:$FAKE_PORT/__stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))')
    if [ "$n" = "$last" ]; then same=$(( same + 1 )); [ $same -ge 4 ] && break; else same=0; fi
    last=$n; sleep 2
  done
}

need_dir() { [ -n "$1" ] && [ -f "$1/.next/BUILD_ID" ] || { echo "$2 没设或没打包：$1"; exit 1; }; }

cmd_seed() {
  need_dir "$PERF_BASE_DIR" PERF_BASE_DIR
  export PERF_APP_DIR=$PERF_BASE_DIR
  progress "建夹具：库 $DB_NAME（$DB_HOST:$DB_PORT），代码 $PERF_BASE_DIR"
  (cd "$PERF_DIR" && node seed/00-config.mjs > "$LOGS/seed-00.log") || return 1
  stop_fake
  (cd "$PERF_DIR" && node seed/01-base.mjs) || return 1
  ensure_fake || return 1
  start_app "$PERF_BASE_DIR" seed-onboard || return 1
  (cd "$PERF_DIR" && node seed/02-onboard.mjs) || { stop_app; return 1; }
  stop_app
  (cd "$PERF_DIR" && node seed/03-history.mjs) || return 1
  start_app "$PERF_BASE_DIR" seed-recon || return 1
  (cd "$PERF_DIR" && node seed/04-recon.mjs "$RECON_DAYS") || { stop_app; return 1; }
  stop_app
  progress "夹具建好"
}

cmd_measure() {
  local label=$1 dir=$2
  need_dir "$dir" "应用目录（$label）"
  local out=$PERF_OUT/$label
  rm -rf "$out"; mkdir -p "$out"
  git -C "$dir" rev-parse HEAD > "$out/commit.txt" 2>/dev/null || echo "?" > "$out/commit.txt"
  export PERF_APP_DIR=$dir
  ensure_fake || return 1
  start_app "$dir" "$label" || return 1
  echo "$STARTUP_LINE" > "$out/startup.txt"
  warm
  local rc=0
  (cd "$PERF_DIR" && node measure/db.mjs snap "$out") || rc=1
  (cd "$PERF_DIR" && node measure/api.mjs "$out" "$API_N" | tee "$out/api.txt") || rc=1
  (cd "$PERF_DIR" && node measure/background.mjs "$out" "$BG_SEC" > "$out/background.txt") || rc=1
  stop_app
  (cd "$PERF_DIR" && node measure/db.mjs report "$out" > "$out/db.txt") || rc=1
  (cd "$PERF_DIR" && node measure/summarize.mjs "$out" > "$out/summary.md")
  progress "测量 $label 完成：$out/summary.md"
  return $rc
}

cmd_parity() {
  need_dir "$PERF_BASE_DIR" PERF_BASE_DIR
  need_dir "$PERF_HEAD_DIR" PERF_HEAD_DIR
  local rc=0
  export PERF_APP_DIR=$PERF_BASE_DIR
  rm -f "$PERF_OUT/parity/base.json" "$PERF_OUT/parity/head.json" "$PERF_OUT/parity/parity.md"
  (cd "$PERF_DIR" && node parity.mjs move "$PARITY_DAYS") || return 1
  ensure_fake || rc=1
  # 对拍时停掉定时换 Key（并换回绑定的那把）：60 秒一换会让被换渠道的绑定和 base 合理地不同；结束后恢复，稳态窗口照常换
  key_agent_on && curl -sf -m 5 "http://127.0.0.1:$FAKE_PORT/__ctl?key_agent_rotate_pause=1" > /dev/null
  if start_app "$PERF_BASE_DIR" parity-base; then
    (cd "$PERF_DIR" && node parity.mjs settle base) || rc=1
  else rc=1; fi
  stop_app
  (cd "$PERF_DIR" && node parity.mjs reset) || rc=1
  if start_app "$PERF_HEAD_DIR" parity-head; then
    (cd "$PERF_DIR" && PERF_APP_DIR=$PERF_HEAD_DIR node parity.mjs settle head) || rc=1
  else rc=1; fi
  stop_app
  # 不管上面成不成，夹具都恢复成挪走前的样子（后面 head 的性能测量要用）
  (cd "$PERF_DIR" && node parity.mjs restore) || rc=1
  key_agent_on && curl -sf -m 5 "http://127.0.0.1:$FAKE_PORT/__ctl?key_agent_rotate_pause=0" > /dev/null
  if [ -f "$PERF_OUT/parity/base.json" ] && [ -f "$PERF_OUT/parity/head.json" ]; then
    (cd "$PERF_DIR" && node parity.mjs diff base head > /dev/null) || rc=1
  else
    echo "# 对拍没跑完：base 或 head 没导出账本，见 $LOGS/" > "$PERF_OUT/parity/parity.md"; rc=1
  fi
  progress "对拍完成（退出码 $rc）：$PERF_OUT/parity/parity.md"
  return $rc
}

cmd_compare() {
  (cd "$PERF_DIR" && node measure/compare.mjs "$PERF_OUT/base" "$PERF_OUT/head" > "$PERF_OUT/compare.md")
  local rc=$?
  progress "对比完成（退出码 $rc）：$PERF_OUT/compare.md"
  return $rc
}

cmd_all() {
  local rc=0
  trap 'stop_app; stop_fake; (cd "$PERF_DIR" && node parity.mjs restore >/dev/null 2>&1); exit 130' INT TERM
  timed seed cmd_seed || { stop_app; stop_fake; exit 1; }
  timed measure-base cmd_measure base "$PERF_BASE_DIR" || rc=1
  timed parity cmd_parity || rc=1
  timed measure-head cmd_measure head "$PERF_HEAD_DIR" || rc=1
  timed compare cmd_compare || rc=1
  stop_app; stop_fake
  cat "$PERF_OUT/timings.txt"
  progress "全部完成（退出码 $rc）：对拍 $PERF_OUT/parity/parity.md，性能 $PERF_OUT/compare.md"
  return $rc
}

# 本机：提交检出到 $PERF_OUT/apps/<sha>（git worktree），npm ci，next build；同一提交打过就不重打
build_app() {
  local ref=$1 repo sha dir
  repo=$(git -C "$PERF_DIR" rev-parse --show-toplevel) || return 1
  git -C "$repo" cat-file -e "$ref^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin
  sha=$(git -C "$repo" rev-parse "$ref^{commit}") || return 1
  dir=$PERF_OUT/apps/$sha
  if [ -f "$dir/.next/BUILD_ID" ]; then echo "$dir"; return 0; fi
  [ -d "$dir" ] || git -C "$repo" worktree add -q --detach "$dir" "$sha" >&2 || return 1
  progress "打包 $ref（$sha）到 $dir" >&2
  (cd "$dir" && npm ci --no-audit --no-fund > "$LOGS/npm-ci-$sha.log" 2>&1 && npx next build > "$LOGS/build-$sha.log" 2>&1) \
    || { echo "打包失败，见 $LOGS/npm-ci-$sha.log、$LOGS/build-$sha.log" >&2; return 1; }
  echo "$dir"
}

cmd=$1; shift
case "$cmd" in
  local)
    [ -n "$1" ] && [ -n "$2" ] || { echo "用法：run.sh local <base 提交> <head 提交>"; exit 1; }
    rm -f "$PERF_OUT/timings.txt"
    PERF_BASE_DIR=$(timed build-base build_app "$1") || exit 1
    PERF_HEAD_DIR=$(timed build-head build_app "$2") || exit 1
    export PERF_BASE_DIR PERF_HEAD_DIR
    cmd_all; exit $? ;;
  all) rm -f "$PERF_OUT/timings.txt"; cmd_all; exit $? ;;
  seed) timed seed cmd_seed; rc=$?; stop_app; exit $rc ;;
  measure) timed "measure-$1" cmd_measure "$1" "$2"; exit $? ;;
  parity) timed parity cmd_parity; exit $? ;;
  compare) timed compare cmd_compare; exit $? ;;
  stop) stop_app; stop_fake; exit 0 ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
