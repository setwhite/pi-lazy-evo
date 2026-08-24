#!/usr/bin/env bash
# 查询实体最新验证状态，供门控使用。
# 用法: ./status.sh <实体id>
# 输出: none（无记录）| "<result> <checked_at>"（passed/failed + 时间）

set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "用法: ./status.sh <实体id>" >&2
  exit 2
fi
id="$1"

# 记忆库根目录：优先 $MEMORY_DIR，其次 git 根，最后当前目录
repo_root="$PWD"
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  repo_root="$(git rev-parse --show-toplevel)"
fi
memory_dir="${MEMORY_DIR:-$repo_root/.memory}"

# 该实体的全部验证记录（兼容 target 带/不带 .memory/ 前缀），取修改时间最新的一份
target="entities/$id.md"
latest_file="$(grep -rlE -- "target: (\\.memory/)?$target$" "$memory_dir/verifications" 2>/dev/null \
  | tr '\n' '\0' | xargs -0 -r stat -c '%Y %n' | sort -rn | head -1 | cut -d' ' -f2-)"

if [ -z "$latest_file" ]; then
  echo "none"
  exit 0
fi

result="$(sed -n 's/^result: //p' "$latest_file" | head -1)"
checked="$(sed -n 's/^checked_at: //p' "$latest_file" | head -1)"
echo "$result $checked"