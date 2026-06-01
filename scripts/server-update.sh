#!/usr/bin/env bash
#
# 在服务器上一键更新：拉取最新代码 -> 装依赖 -> 重启服务 -> 自测。
# 用法（在 Cloudflare 网页终端里）：
#     sudo bash /opt/web-music/app/scripts/server-update.sh
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/web-music/app}"
PORT="${PORT:-9277}"

cd "$APP_DIR"

echo "==> 拉取最新代码 (git pull)"
git pull --ff-only

echo "==> 安装依赖 (npm ci)"
npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

echo "==> 重启服务"
systemctl restart web-music
sleep 2

code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" || echo "000")
echo "已更新到 $(git rev-parse --short HEAD)，本机自测 HTTP $code"
[[ "$code" == "200" ]] || echo "!! 自测非 200，请看日志：journalctl -u web-music -n 50 --no-pager"
