#!/usr/bin/env bash
#
# 用当前源码树重新生成自解压一键安装脚本 install-web-music.sh。
# 产物 = scripts/installer-head.sh（逻辑） + 源码树打包后的 base64。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEAD="$ROOT/scripts/installer-head.sh"
OUT="$ROOT/install-web-music.sh"
TARBALL="$(mktemp -t wm-app.XXXXXX).tar.gz"
trap 'rm -f "$TARBALL"' EXIT

[[ -f "$HEAD" ]] || { echo "缺少 $HEAD" >&2; exit 1; }

# 打包源码树（排除依赖、用户数据、git、产物本身）
TAR_OPTS=(
  --exclude=node_modules
  --exclude=data
  --exclude=.git
  --exclude='.DS_Store'
  --exclude=install-web-music.sh
)
# macOS 的 bsdtar 支持 --no-mac-metadata，可去掉 ._ 资源叉；GNU tar 没有该选项
if tar --no-mac-metadata --help >/dev/null 2>&1; then
  TAR_OPTS+=(--no-mac-metadata)
fi

COPYFILE_DISABLE=1 tar "${TAR_OPTS[@]}" -czf "$TARBALL" -C "$ROOT" .

cp "$HEAD" "$OUT"
base64 < "$TARBALL" >> "$OUT"
chmod +x "$OUT"

echo "已生成：$OUT ($(du -h "$OUT" | cut -f1))"
