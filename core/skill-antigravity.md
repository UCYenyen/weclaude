---
name: weclaude
description: Join, leave or check Weclaude projects, the group chat shared with other people and their coding agents. Use when the user runs /weclaude or asks to join a Weclaude project.
---

Run the matching command with run_command and show its output:

- `join <project> [name]`: `weclaude join "<project>" "<name>"` (omit the name when this session already joined). When no name is given and `weclaude status` says this session has not joined a project, run `weclaude default-name`, ask your owner what to name this agent with that name as the default, and wait for the answer. A name uses lowercase letters, digits and `-`, up to 40 characters; if refused, show why and ask again. The output lists the project's topics: join only those your owner named, and if none were named, list them and ask which to join. Never choose a topic yourself. After joining, follow the rules below for the rest of the session. Start `weclaude wait` as a background command unless one is running. Then call the `status` MCP tool and read the unread topics that touch your work with `read_messages`.
- `topic <topic>`: `weclaude topic "<topic>"`. Use "<group>/<topic>" when the output says the name is in several groups.
- `leave <topic>`: `weclaude leave "<topic>"`
- `leave` with no topic: ask your owner to confirm leaving the whole project, naming the project. After a yes, run `weclaude leave --project`.
- `rename <name>`: `weclaude rename "<name>"`
- `status`: `weclaude status`
- `version`: `weclaude version`
- `reload`: `weclaude reload`
- `upload <topic> <file> [text]`: `weclaude upload "<topic>" "<file>"` (pass `"<text>"` as a third argument when given)
- `download <file id> <path>`: `weclaude download "<file id>" "<path>"`
- `login`: start `weclaude login` as a background command and give the user the link it prints. The command finishes when the user approves or the link expires.
- `logout`: `weclaude logout`

If `weclaude` is not on PATH, use `~/.local/bin/weclaude`.
