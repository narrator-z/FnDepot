#!/usr/bin/env bash
# upstream-check.sh — 检查 Chat2API-WXS 上游是否有新 tag
#
# 用法：
#   bash chat2api/scripts/upstream-check.sh
#
# 环境变量：
#   GITHUB_TOKEN  — 可选，用于提高 API 速率限制（CI 自动注入）
#
# 输出（stdout）：
#   UPSTREAM_TAG=<tag名称>
#   LOCAL_TAG=<tag名称或uninitialized>
#   NEEDS_UPDATE=true/false
#
# 退出码：0=正常，1=查询失败
#
# 设计要点：
#   - 以上游 narrator-z/Chat2API-WXS 的最新 tag 为版本基准。
#   - tag 记录在 chat2api/build/.upstream-ref，每次成功构建+发布后更新。
#   - 本地自定义改动在 build/shim/ 下，与上游代码物理隔离，更新不覆盖。
set -euo pipefail

UPSTREAM_REPO="narrator-z/Chat2API-WXS"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REF_FILE="$SCRIPT_DIR/../build/.upstream-ref"
CHANGELOG_FILE="$SCRIPT_DIR/../build/.upstream-changelog"

# --- 查上游最新 tag ---
AUTH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_ARGS+=( -H "Authorization: token $GITHUB_TOKEN" )
fi

UPSTREAM_TAG=$(curl -sf "${AUTH_ARGS[@]}" \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: fnos-upstream-check" \
  "https://api.github.com/repos/$UPSTREAM_REPO/tags?per_page=1" \
  | jq -r '.[0].name // empty')

if [ -z "$UPSTREAM_TAG" ]; then
  echo "ERROR: 上游 $UPSTREAM_REPO 还没有 tag，无法检测更新。请先在上游仓库创建 tag。"
  exit 1
fi

# --- 读本地记录的 tag ---
LOCAL_TAG=""
if [ -f "$REF_FILE" ]; then
  LOCAL_TAG=$(tr -d '[:space:]' < "$REF_FILE")
fi

echo "UPSTREAM_TAG=$UPSTREAM_TAG"
echo "LOCAL_TAG=${LOCAL_TAG:-uninitialized}"

if [ "$UPSTREAM_TAG" = "$LOCAL_TAG" ]; then
  echo "NEEDS_UPDATE=false"
else
  echo "NEEDS_UPDATE=true"
fi
