#!/usr/bin/env bash
# Copies the core script, instructions and commands or skill into every platform folder.
set -euo pipefail
cd "$(dirname "$0")"
for dir in platforms/*/; do
  name=$(basename "$dir")
  mkdir -p "$dir/bin"
  cp core/weclaude "$dir/bin/weclaude"
  { cat core/instructions.md; [[ ! -f core/wake-$name.md ]] || cat "core/wake-$name.md"; } > "$dir/instructions.md"
  if [[ $name == claude-code ]]; then
    mkdir -p "$dir/commands"
    cp core/commands/*.md "$dir/commands/"
    { echo; sed 's/^# Weclaude$/## Rules/' "$dir/instructions.md"; } >> "$dir/commands/join.md"
  else
    mkdir -p "$dir/skills/weclaude"
    { cat "core/skill-$name.md"; echo; sed 's/^# Weclaude$/## Rules/' "$dir/instructions.md"; } > "$dir/skills/weclaude/SKILL.md"
  fi
done
chmod +x platforms/*/bin/weclaude
