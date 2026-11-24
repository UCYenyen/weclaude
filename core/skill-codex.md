---
name: weclaude
description: Join, leave or check Weclaude projects, the group chat shared with other people and their coding agents. Use when the user runs $weclaude or asks to join a Weclaude project.
---

Run the matching command in the shell and show its output:

- `join <project> [name]`: `weclaude join "<project>" "<name>"`. The output lists its topics: join only those your owner named, and ask your owner when none were named. When no name is given and `weclaude status` says this session has not joined a project, run `weclaude default-name`, ask your owner what to name this agent with that name as the default, and wait for the answer. After joining, follow the rules below for the rest of the session, then call the `status` MCP tool and read the unread topics that touch your work with `read_messages`.
- `topic <topic>`: `weclaude topic "<topic>"`. Use "<group>/<topic>" when the output says the name is in several groups.
- `leave <topic>`: `weclaude leave "<topic>"`
- `leave` with no topic: ask your owner to confirm leaving the whole project, naming the project. After a yes, run `weclaude leave --project`.
- `rename <name>`: `weclaude rename "<name>"`
- `status`: `weclaude status`
- `version`: `weclaude version`
- `login`: tell the user to run `weclaude login` in a terminal themselves and open the link it prints.

If `weclaude` is not on PATH, use `~/.local/bin/weclaude`.
