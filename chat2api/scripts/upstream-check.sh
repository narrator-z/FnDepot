#!/usr/bin/env bash
# upstream-check.sh — 检查 Chat2API-WXS 上游 main 分支是否有新提交
#
# 用法：
#   bash chat2api/scripts/upstream-check.sh
#
# 环境变量：
#   GITHUB_TOKEN  — 可选，用于提高 API 速率限制（CI 自动注入）
#
# 输出（stdout）：
#   UPSTREAM_SHA=<40位SHA>
#   LOCAL_SHA=<40位SHA或uninitialized>
#   NEEDS_UPDATE=true/false
#
# 退出码：0=正常，1=查询失败
#
# 设计要点：
#   - 上游 narrator-z/Chat2API-WXS 没有 release/tag，所以以 main HEAD 的 commit SHA 为版本基准。
#   - SHA 记录在 chat2api/build/.upstream-sha，每次成功构建+发布后更新。
#   - 本地自定义改动在 build/shim/ 下，与上游代码物理隔离，更新不覆盖。
set -euo pipefail

UPSTREAM_REPO="narrator-z/Chat2API-WXS"
UPSTREAM_BRANCH="main"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHA_FILE="$SCRIPT_DIR/../build/.upstream-sha"
CHANGELOG_FILE="$SCRIPT_DIR/../build/.upstream-changelog"

# --- 查上游 main HEAD SHA ---
AUTH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_ARGS+=( -H "Authorization: token $GITHUB_TOKEN" )
fi

UPSTREAM_SHA=$(curl -sf "${AUTH_ARGS[@]}" \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: fnos-upstream-check" \
  "https://api.github.com/repos/$UPSTREAM_REPO/commits/$UPSTREAM_BRANCH" \
  | jq -r '.sha // empty')

if [ -z "$UPSTREAM_SHA" ]; then
  echo "ERROR: 无法获取上游 $UPSTREAM_REPO@$UPSTREAM_BRANCH 的 SHA"
  exit 1
fi

# --- 读本地记录的 SHA ---
LOCAL_SHA=""
if [ -f "$SHA_FILE" ]; then
  LOCAL_SHA=$(tr -d '[:space:]' < "$SHA_FILE")
fi

echo "UPSTREAM_SHA=$UPSTREAM_SHA"
echo "LOCAL_SHA=${LOCAL_SHA:-uninitialized}"

if [ "$UPSTREAM_SHA" = "$LOCAL_SHA" ]; then
  echo "NEEDS_UPDATE=false"
else
  echo "NEEDS_UPDATE=true"
fi
