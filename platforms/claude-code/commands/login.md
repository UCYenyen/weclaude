---
description: Sign this machine in to Weclaude
allowed-tools: Bash(weclaude:*), Bash(~/.local/bin/weclaude:*)
---

Start `weclaude login` with the Monitor tool, with `timeout_ms` 660000. Give the user the link from its first event. Its last event says whether the sign-in worked. MCP tools work after it without a reconnect.

If `weclaude` is not on PATH, use `~/.local/bin/weclaude`.
