#!/usr/bin/env bash
# 批量重跑历史验证记录中声明的 code: 验证器（L2 层）。
# 命令来源：verifications/ 里每条 validator: code: <命令>，同一实体只取最新一条。
# 用法: ./verify.sh
# 输出: 每行 "<实体id> <退出码> OK|FAIL <命令>"，末尾汇总

set -uo pipefail

# 记忆库根目录：优先 $MEMORY_DIR，其次 git 根，最后当前目录
repo_root="$PWD"
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  repo_root="$(git rev-parse --show-toplevel)"
fi
memory_dir="${MEMORY_DIR:-$repo_root/.memory}"

: "${memory_dir:?未找到 .memory 目录}"

# 逐条记录提取 (target, mtime, cmd)
entries="$(mktemp)"
for rec in "$memory_dir"/verifications/*.md; do
  [ -e "$rec" ] || continue
  cmd="$(sed -n 's/^validator: code: //p' "$rec" | head -1 | xargs)"
  [ -n "$cmd" ] || continue
  target="$(sed -n 's/^target: //p' "$rec" | head -1 | xargs)"
  # 历史记录 target 可能带 .memory/ 前缀，统一用 basename 提取实体 id
  mtime="$(stat -c '%Y' "$rec")"
  printf '%s\t%s\t%s\n' "$target" "$mtime" "$cmd" >> "$entries"
done

# 每实体保留最新一条验证命令，逐条执行，结果落临时文件（子 shell 不传变量）
results="$(mktemp)"
sort "$entries" | awk -F'\t' '
  !( $1 in m ) || $2 > m[$1] { m[$1] = $2; c[$1] = $3 }
  END { for (t in c) print t "\t" c[t] }
' | while IFS=$'\t' read -r target cmd; do
  id="$(basename "$target" .md)"
  if bash -c "$cmd" >/dev/null 2>&1; then
    echo "$id 0 OK $cmd" >> "$results"
  else
    echo "$id 1 FAIL $cmd" >> "$results"
  fi
done

# 统计后再输出
total="$(wc -l < "$results")"
failed="$(grep -c 'FAIL' "$results" || true)"
cat "$results"
echo "---"
echo "共 $total 个 code 验证器，失败 $failed 个"
rm -f "$entries" "$results"