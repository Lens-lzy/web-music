#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${1:-your-server.example.com}"
DOMAIN="${DOMAIN:-your-domain.example.com}"
APP_DIR="${APP_DIR:-/opt/web-music/app}"
SOURCE_DIR="${SOURCE_DIR:-/opt/lx-music-source-main}"
DATA_DIR="${DATA_DIR:-/var/lib/web-music}"
ENV_DIR="${ENV_DIR:-/etc/web-music}"
TMP_APP="/tmp/web-music-release"
TMP_SOURCE="/tmp/lx-music-source-main"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Source scripts are now bundled inside the package at <root>/lx-music-source-main.
SOURCE_ROOT="$(cd "$ROOT_DIR/lx-music-source-main" && pwd)"

if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "Missing bundled source scripts directory: $ROOT_DIR/lx-music-source-main" >&2
  exit 1
fi

echo "Syncing app to $REMOTE_HOST..."
rsync -az --delete \
  --exclude node_modules \
  --exclude data \
  --exclude .git \
  --exclude lx-music-source-main \
  "$ROOT_DIR/" "$REMOTE_HOST:$TMP_APP/"

echo "Syncing lx source scripts to $REMOTE_HOST..."
rsync -az --delete "$SOURCE_ROOT/" "$REMOTE_HOST:$TMP_SOURCE/"

echo "Installing release on $REMOTE_HOST..."
ssh "$REMOTE_HOST" "DOMAIN='$DOMAIN' APP_DIR='$APP_DIR' SOURCE_DIR='$SOURCE_DIR' DATA_DIR='$DATA_DIR' ENV_DIR='$ENV_DIR' TMP_APP='$TMP_APP' TMP_SOURCE='$TMP_SOURCE' bash -s" <<'REMOTE'
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node 18+ first, then rerun this script." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install npm first, then rerun this script." >&2
  exit 1
fi

if ! getent group webmusic >/dev/null; then
  sudo groupadd --system webmusic
fi
if ! id webmusic >/dev/null 2>&1; then
  sudo useradd --system --gid webmusic --home "$DATA_DIR" --shell /usr/sbin/nologin webmusic
fi

sudo mkdir -p "$APP_DIR" "$SOURCE_DIR" "$DATA_DIR" "$ENV_DIR"
sudo rsync -a --delete "$TMP_APP/" "$APP_DIR/"
sudo rsync -a --delete "$TMP_SOURCE/" "$SOURCE_DIR/"
sudo chown -R webmusic:webmusic "$DATA_DIR"
sudo chmod 750 "$DATA_DIR"

if [[ ! -f "$ENV_DIR/web-music.env" ]]; then
  initial_password="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
  sudo tee "$ENV_DIR/web-music.env" >/dev/null <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=9277
WEB_MUSIC_DATA_DIR=$DATA_DIR
LX_SOURCE_DIR=$SOURCE_DIR
LX_SOURCE_PRIORITY=juhe,lx,grass,flower,huibq,sixyin,ikun
WEB_MUSIC_ADMIN_USER=admin
WEB_MUSIC_ADMIN_PASSWORD=$initial_password
ENV
  sudo chmod 640 "$ENV_DIR/web-music.env"
  echo "Created $ENV_DIR/web-music.env with initial admin password: $initial_password"
else
  echo "Keeping existing $ENV_DIR/web-music.env"
fi

cd "$APP_DIR"
sudo npm ci --omit=dev

sudo cp "$APP_DIR/deploy/web-music.service" /etc/systemd/system/web-music.service
node_path="$(command -v node)"
sudo sed -i "s#^ExecStart=.*#ExecStart=$node_path server/index.js#" /etc/systemd/system/web-music.service
sudo systemctl daemon-reload
sudo systemctl enable --now web-music
sudo systemctl restart web-music
sudo systemctl --no-pager --full status web-music || true

if command -v nginx >/dev/null 2>&1; then
  sudo cp "$APP_DIR/deploy/nginx.example.conf" "/etc/nginx/sites-available/$DOMAIN"
  sudo ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
  sudo nginx -t
  sudo systemctl reload nginx
else
  echo "nginx is not installed; skipped nginx config."
fi
REMOTE

echo "Done. Point DNS for $DOMAIN at this server, then open https://$DOMAIN/"
