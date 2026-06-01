#!/usr/bin/env bash
#
# 从上游第三方仓库拉取音源脚本到 ./lx-music-source-main/。
# 本仓库【不内置】这些第三方脚本，首次部署或换机时运行本脚本获取。
#
# 用法：
#     bash scripts/fetch-sources.sh
# 可用 LX_SOURCE_UPSTREAM 覆盖上游地址。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/lx-music-source-main"
UPSTREAM="${LX_SOURCE_UPSTREAM:-https://github.com/pdone/lx-music-source.git}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> 克隆上游音源仓库：$UPSTREAM"
git clone --depth 1 "$UPSTREAM" "$TMP/src"

mkdir -p "$DEST"
for s in flower grass huibq ikun juhe lx sixyin; do
  if [[ -d "$TMP/src/$s" ]]; then
    rm -rf "$DEST/$s"
    cp -r "$TMP/src/$s" "$DEST/$s"
    echo "    + $s"
  else
    echo "    ? 上游缺少 $s，跳过"
  fi
done

echo "==> 完成。音源已就绪：$DEST"
echo "   （这些是第三方脚本，版权归原作者；本目录已被 .gitignore 忽略，不会提交）"
