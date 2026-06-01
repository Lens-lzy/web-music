#!/usr/bin/env bash
#
# web-music 一键安装脚本（自解压，分发版）。应用代码 + 内置音源都打包在本文件内。
#
# 用法（在 Ubuntu / Debian 服务器上，需 root）：
#     sudo bash install-web-music.sh
#   自定义端口（默认 9277）：
#     sudo PORT=8080 bash install-web-music.sh
#   顺便连 Cloudflare Tunnel（先在自己的 Cloudflare 控制台建隧道拿到 token）：
#     sudo TUNNEL_TOKEN=你的token bash install-web-music.sh
#
# 外网访问：应用只监听 127.0.0.1，需自行用 Cloudflare Tunnel 或 Nginx+域名暴露。
#
set -euo pipefail

APP_DIR=/opt/web-music/app
DATA_DIR=/var/lib/web-music
ENV_DIR=/etc/web-music
ENV_FILE="$ENV_DIR/web-music.env"
PORT="${PORT:-9277}"

echo "============================================================"
echo " web-music 安装程序"
echo "============================================================"

# --- 前置检查 ---------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "✗ 需要 root 权限。请用：sudo bash $0" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "✗ 本脚本只支持 Debian / Ubuntu 系（依赖 apt-get）。" >&2
  echo "  当前系统不是 apt 系，请手动安装 Node 18+ 后参考 README 部署。" >&2
  exit 1
fi

for c in curl tar base64 openssl; do
  command -v "$c" >/dev/null 2>&1 || { echo "✗ 缺少命令：$c，请先 apt-get install -y $c" >&2; exit 1; }
done

# 端口占用检查（仅提示，不强制退出）
if command -v ss >/dev/null 2>&1 && ss -ltnH "( sport = :$PORT )" 2>/dev/null | grep -q .; then
  echo "⚠ 端口 $PORT 似乎已被占用。若占用者不是本服务，请改用 PORT=其它端口 重跑。"
  echo "  3 秒后继续（Ctrl-C 取消）..."; sleep 3
fi

echo "==> [1/7] 检查 Node.js"
need_node=0
if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  [[ "$major" -ge 18 ]] || need_node=1
else
  need_node=1
fi
if [[ "$need_node" -eq 1 ]]; then
  echo "    安装 Node.js 20.x ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> [2/7] 创建目录与运行账户"
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR"
groupadd --system webmusic 2>/dev/null || true
id webmusic >/dev/null 2>&1 || \
  useradd --system --gid webmusic --home "$DATA_DIR" --shell /usr/sbin/nologin webmusic
chown -R webmusic:webmusic "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> [3/7] 释放应用代码（含内置音源）到 $APP_DIR"
ARCHIVE_LINE=$(awk '/^__ARCHIVE_BELOW__$/{print NR+1; exit 0}' "$0")
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tail -n +"$ARCHIVE_LINE" "$0" | base64 -d | tar -xzf - -C "$APP_DIR"

echo "==> [4/7] 安装生产依赖"
cd "$APP_DIR"
# 优先用 npm ci（按 lock 精确还原）；若 lock 与 package.json 不一致则回退到 npm install
npm ci --omit=dev || {
  echo "    npm ci 失败，回退到 npm install --omit=dev ..."
  npm install --omit=dev --no-audit --no-fund
}

echo "==> [5/7] 写入环境变量（端口 $PORT）"
if [[ -f "$ENV_FILE" ]]; then
  echo "    已存在 $ENV_FILE，保留原有配置（不改密码）"
else
  PW=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
WEB_MUSIC_DATA_DIR=$DATA_DIR
LX_SOURCE_PRIORITY=juhe,lx,grass,flower,huibq,sixyin,ikun
WEB_MUSIC_ADMIN_USER=admin
WEB_MUSIC_ADMIN_PASSWORD=$PW
EOF
  chmod 640 "$ENV_FILE"
  GENERATED_PW="$PW"
fi

echo "==> [6/7] 安装并启动 systemd 服务"
node_path="$(command -v node)"
sed "s#^ExecStart=.*#ExecStart=$node_path server/index.js#" \
  "$APP_DIR/deploy/web-music.service" > /etc/systemd/system/web-music.service
systemctl daemon-reload
systemctl enable --now web-music
systemctl restart web-music
sleep 3

echo "==> [7/7] 本机自测 http://127.0.0.1:$PORT/"
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" || echo "000")
if [[ "$code" == "200" ]]; then
  echo "    OK：应用已在 127.0.0.1:$PORT 运行"
else
  echo "    !! 自测返回 HTTP $code，请看日志：journalctl -u web-music -n 50 --no-pager"
fi

# 可选：提供了 TUNNEL_TOKEN 就顺手装 cloudflared 并连上隧道
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  echo "==> 额外：安装 cloudflared 并连接隧道"
  if ! command -v cloudflared >/dev/null 2>&1; then
    mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg > /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update && apt-get install -y cloudflared
  fi
  cloudflared service install "$TUNNEL_TOKEN"
  echo "    cloudflared 已安装为服务。请在 Cloudflare 控制台给该隧道加 Public Hostname："
  echo "      <你的域名>  ->  HTTP  ->  localhost:$PORT"
fi

echo
echo "============================================================"
echo " 完成！应用监听 127.0.0.1:$PORT（仅本机，外网需自行用 Tunnel/Nginx 暴露）"
if [[ -n "${GENERATED_PW:-}" ]]; then
  echo " 初始管理员：admin"
  echo " 初始密码  ：$GENERATED_PW   <- 请记下，登录后立刻改密码"
else
  echo " 管理员账号沿用已有配置（如忘记密码，删 $ENV_FILE 与 $DATA_DIR/users.json 后重跑本脚本）"
fi
echo
echo " 外网访问（任选其一）："
echo "   · Cloudflare Tunnel：建隧道拿 token 后重跑  sudo TUNNEL_TOKEN=xxx bash $0"
echo "     再在控制台加 Public Hostname：<你的域名> -> HTTP -> localhost:$PORT"
echo "   · Nginx + 域名：见 $APP_DIR/deploy/nginx.example.conf"
echo "============================================================"
exit 0
__ARCHIVE_BELOW__
