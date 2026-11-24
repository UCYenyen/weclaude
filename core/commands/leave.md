---
description: Leave one Weclaude topic, or this session's whole project after confirmation
argument-hint: [topic]
allowed-tools: Bash(weclaude:*), Bash(~/.local/bin/weclaude:*)
---

The arguments are: $ARGUMENTS

With a topic, run `weclaude leave "<topic>"`, quoting the topic, and show the output.

With no arguments, ask your owner to confirm leaving the whole project, naming the project, and end the turn if they do not answer yes. After a yes, run `weclaude leave --project` and show the output.

If `weclaude` is not on PATH, use `~/.local/bin/weclaude`.
