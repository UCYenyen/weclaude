// The MCP tools agents call through `weclaude mcp`, served as JSON-RPC over POST /api/mcp.
import { all, get, run, now, tx, topicRow, topicPath, readSeq, markRead, markSummarySeen, unread, username } from './db.js';
import { postMessage, agentState, wakeDirect, roundInfo } from './core.js';
import { randomBytes } from 'node:crypto';

export const SERVER_INFO = { name: 'weclaude', version: '0.1.0' };
const topicArg = { type: 'string', description: 'Topic id, or "Project/Group/Topic"' };

export const TOOLS = [
  { name: 'status', description: 'Your agent name, current task, and the topics you joined with unread counts, and the other topics in your project.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_messages', description: "Messages in a topic, oldest first. Without before_seq it returns the latest page, or from your first unread message when more are unread than fit, and marks them read. Pass before_seq to page back, or query to search the whole history. Once after the topic's summary changes, the summary comes before the page.", inputSchema: { type: 'object', properties: { topic: topicArg, before_seq: { type: 'integer' }, limit: { type: 'integer', default: 30 }, query: { type: 'string', description: 'Words to search for in the whole topic history. Returns the newest matches and marks nothing read.' } }, required: ['topic'] } },
  { name: 'mark_read', description: 'Marks messages up to seq as read.', inputSchema: { type: 'object', properties: { topic: topicArg, seq: { type: 'integer' } }, required: ['topic', 'seq'] } },
  { name: 'post', description: 'Posts a chat message. The web shows Markdown with headings at body size, and math between $$ signs. Mention every member who must act with @username for a human or @owner/name for an agent, in the body or in "to". A mentioned agent must reply. A mentioned human gets a notification.', inputSchema: { type: 'object', properties: { topic: topicArg, body: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, reply_to_seq: { type: 'integer' } }, required: ['topic', 'body'] } },
  { name: 'list_members', description: "Humans and agents in a topic, with each agent's owner, task and state: thinking, idle or offline.", inputSchema: { type: 'object', properties: { topic: topicArg }, required: ['topic'] } },
  { name: 'set_task', description: 'Sets the one-line task shown under your name.', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'memory_index', description: 'Names and descriptions of the project memory entries you may see, newest first.', inputSchema: { type: 'object', properties: { topic: topicArg, query: { type: 'string' } }, required: ['topic'] } },
  { name: 'memory_get', description: 'One memory entry with its sources, links and corrections.', inputSchema: { type: 'object', properties: { topic: topicArg, name: { type: 'string' } }, required: ['topic', 'name'] } },
  { name: 'memory_write', description: 'Writes a memory entry, once. name: lowercase words joined by -. description: one sentence, at most 200 characters. sources: message seqs in this topic. links: other entry names. corrects: the entry this one corrects.', inputSchema: { type: 'object', properties: { topic: topicArg, name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, sources: { type: 'array', items: { type: 'integer' } }, links: { type: 'array', items: { type: 'string' } }, corrects: { type: 'string' } }, required: ['topic', 'name', 'description', 'body'] } },
  { name: 'memory_propose', description: 'Asks the server to choose who writes a memory entry about some messages. It wakes the agent holding most of that context.', inputSchema: { type: 'object', properties: { topic: topicArg, message_seqs: { type: 'array', items: { type: 'integer' } } }, required: ['topic', 'message_seqs'] } },
  { name: 'memory_object', description: 'Hands a memory proposal to the next-ranked agent. One objection per proposal, within 60 s.', inputSchema: { type: 'object', properties: { proposal_id: { type: 'string' } }, required: ['proposal_id'] } },
  { name: 'conclude', description: 'Posts what a discussion between agents concluded, as a card. kind decision: what the agents agreed; every person in the topic is notified. kind request: what the agents need from people, such as information or an approval; put those people in "to", and they are notified. text: the decision or the request in one to three sentences. message_seqs: the messages it came from.', inputSchema: { type: 'object', properties: { topic: topicArg, kind: { type: 'string', enum: ['decision', 'request'] }, text: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, message_seqs: { type: 'array', items: { type: 'integer' } } }, required: ['topic', 'kind', 'text'] } },
  { name: 'skill_get', description: 'The instructions of one project skill, and the files that came with it. Follow them while you work on this project.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'skill_file', description: 'One file of a project skill, by the path skill_get lists.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'] } },
  { name: 'list_files', description: 'Files uploaded in a topic. Download one with: weclaude download <file id> <path>.', inputSchema: { type: 'object', properties: { topic: topicArg }, required: ['topic'] } },
];

export class ToolError extends Error {}
const fail = (m) => { throw new ToolError(m); };

const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function projectTopics(projectId) {
  return all(`SELECT t.*, g.name AS group_name, p.name AS project_name FROM topics t JOIN groups_ g ON g.id=t.group_id JOIN projects p ON p.id=t.project_id WHERE t.project_id=? ORDER BY g.name, t.name`, projectId);
}

// A topic of the project by id ("t12" or "12"), "Project/Group/Topic", "Group/Topic" or a unique topic name.
export function resolveTopic(projectId, ref) {
  const s = String(ref ?? '').trim();
  if (!s) fail('Give a topic: its id or "Project/Group/Topic".');
  const topics = projectTopics(projectId);
  const id = s.match(/^t?(\d+)$/i);
  if (id) { const t = topics.find((x) => x.id === Number(id[1])); if (t) return t; }
  const parts = s.split('/').map((x) => x.trim().toLowerCase()).filter(Boolean);
  let hits = [];
  if (parts.length === 3) hits = topics.filter((t) => t.project_name.toLowerCase() === parts[0] && t.group_name.toLowerCase() === parts[1] && t.name.toLowerCase() === parts[2]);
  else if (parts.length === 2) hits = topics.filter((t) => t.group_name.toLowerCase() === parts[0] && t.name.toLowerCase() === parts[1]);
  else if (parts.length === 1) hits = topics.filter((t) => t.name.toLowerCase() === parts[0]);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail(`"${s}" is in several groups: ${hits.map((t) => `${t.group_name}/${t.name}`).join(', ')}. Use "<group>/<topic>".`);
  fail(`No topic "${s}" in this project. Topics: ${topics.map((t) => `${t.group_name}/${t.name} (t${t.id})`).join(', ') || 'none yet'}.`);
}

export function formatMessage(m) {
  const who = m.agent_id ? `${m.owner}/${m.agent_name}` : m.author;
  const head = `#${m.seq} ${who}${m.agent_id ? '' : ' (person)'} · ${fmtTime(m.created)}${m.reply_to ? ` · reply to #${m.reply_to}` : ''}`;
  let body = m.body || '';
  if (m.kind === 'decision' || m.kind === 'request') {
    const meta = m.meta ? JSON.parse(m.meta) : {};
    const to = JSON.parse(m.to_ || '[]');
    body = `[${m.kind.toUpperCase()}] ${body}${to.length ? ` → ${to.join(', ')}` : ''}${meta.seqs?.length ? ` (from ${meta.seqs.map((x) => `#${x}`).join(', ')})` : ''}`;
  } else if (m.kind === 'file') {
    body = `[file f${m.file_id} "${m.file_name}" ${fmtSize(m.file_size || 0)}]${body ? ` ${body}` : ''}`;
  } else if (m.kind === 'system') body = `[${body}]`;
  return `${head}\n${body}`;
}

export const MSG_SELECT = `SELECT m.*, u.username AS author, ou.username AS owner, a.name AS agent_name, f.name AS file_name, f.size AS file_size
  FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.id=m.agent_id LEFT JOIN users ou ON ou.id=a.user_id LEFT JOIN files f ON f.id=m.file_id`;

const memoryGate = (agent) => {
  const newest = get('SELECT MAX(created) AS t FROM memory WHERE project_id=?', agent.project_id).t || 0;
  if (!agent.memory_checked || agent.memory_checked < agent.session_started || agent.memory_checked < newest)
    fail('Refused: call memory_index or memory_get first. You have not read project memory since your session started or since the newest entry was written.');
};

export function statusText(agent) {
  const p = get('SELECT * FROM projects WHERE id=?', agent.project_id);
  const joined = new Set(all('SELECT topic_id FROM agent_topics WHERE agent_id=?', agent.id).map((r) => r.topic_id));
  const topics = projectTopics(agent.project_id);
  const lines = [`You are ${agent.owner}/${agent.name} in project ${p.name}. Task: ${agent.task || 'none set'}.`];
  lines.push(`Round limit: ${Math.round(p.round_ms / 1000)} s. Web: ${process.env.PUBLIC_URL || ''}/p/${encodeURIComponent(p.name)}`);
  const mine = topics.filter((t) => joined.has(t.id));
  lines.push(mine.length ? 'Joined topics:' : 'Joined topics: none. Ask your owner which to join.');
  for (const t of mine) {
    const u = unread('a', agent.id, t.id);
    lines.push(`- ${topicPath(t)} (t${t.id}): ${u.n} unread${u.m ? `, ${u.m} mentioning you` : ''}`);
    if (t.summary) lines.push(`  Summary: ${t.summary.replace(/\n/g, '\n  ')}`);
  }
  const others = topics.filter((t) => !joined.has(t.id));
  const mentioned = others.map((t) => [t, unread('a', agent.id, t.id)]).filter(([, u]) => u.m);
  if (mentioned.length) { lines.push('Mentions in other topics:'); for (const [t, u] of mentioned) lines.push(`- ${topicPath(t)} (t${t.id}): ${u.m} mentioning you`); }
  if (others.length) lines.push(`Other topics: ${others.map((t) => `${t.group_name}/${t.name} (t${t.id})`).join(', ')}`);
  const mem = all('SELECT name FROM memory WHERE project_id=? ORDER BY created DESC', agent.project_id).map((r) => r.name);
  lines.push(`Memory entries: ${mem.length ? mem.join(', ') : 'none'}`);
  const skills = all('SELECT name, description FROM skills WHERE project_id=? ORDER BY name', agent.project_id);
  lines.push(skills.length ? `Skills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}` : 'Skills: none');
  const open = all(`SELECT id, topic_id, seqs FROM proposals WHERE project_id=? AND done=0 AND json_extract(ranked, '$[' || idx || ']')=?`, agent.project_id, agent.id);
  for (const pr of open) lines.push(`Memory proposal ${pr.id} is yours: write an entry from t${pr.topic_id} messages ${JSON.parse(pr.seqs).map((x) => `#${x}`).join(', ')} with memory_write, or call memory_object.`);
  return lines.join('\n');
}

// ctx: {user, agent} where agent may be null when the session joined no project.
export function callTool(ctx, name, args = {}) {
  const { agent } = ctx;
  if (!TOOLS.some((t) => t.name === name)) fail(`Unknown tool ${name}.`);
  if (!agent) {
    if (name === 'status') return 'This session has not joined a project. Join one with /weclaude:join <project>.';
    fail('This session has not joined a project. Join one with /weclaude:join <project>.');
  }
  const pid = agent.project_id;
  const me = { userId: agent.user_id, agentId: agent.id };
  switch (name) {
    case 'status': return statusText(agent);

    case 'read_messages': {
      const t = resolveTopic(pid, args.topic);
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
      const out = [];
      let rows;
      if (args.query) {
        const words = String(args.query).split(/\s+/).filter(Boolean).slice(0, 8);
        const where = words.map(() => 'm.body LIKE ?').join(' AND ') || '1';
        rows = all(`${MSG_SELECT} WHERE m.topic_id=? AND ${where} ORDER BY m.seq DESC LIMIT ?`, t.id, ...words.map((w) => `%${w}%`), limit).reverse();
        out.push(`${topicPath(t)} (t${t.id}): ${rows.length} newest match${rows.length === 1 ? '' : 'es'} for "${args.query}". Nothing marked read.`);
      } else if (args.before_seq) {
        rows = all(`${MSG_SELECT} WHERE m.topic_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT ?`, t.id, Number(args.before_seq), limit).reverse();
        out.push(`${topicPath(t)} (t${t.id}): messages before #${args.before_seq}.`);
      } else {
        const rs = readSeq('a', agent.id, t.id);
        const unreadCount = get('SELECT COUNT(*) AS n FROM messages WHERE topic_id=? AND seq>?', t.id, rs.seq).n;
        if (unreadCount > limit) rows = all(`${MSG_SELECT} WHERE m.topic_id=? AND m.seq>? ORDER BY m.seq ASC LIMIT ?`, t.id, rs.seq, limit);
        else rows = all(`${MSG_SELECT} WHERE m.topic_id=? ORDER BY m.seq DESC LIMIT ?`, t.id, limit).reverse();
        const last = rows.at(-1)?.seq || 0;
        if (last) markRead('a', agent.id, t.id, last);
        const left = get('SELECT COUNT(*) AS n FROM messages WHERE topic_id=? AND seq>?', t.id, Math.max(last, rs.seq)).n;
        out.push(`${topicPath(t)} (t${t.id}): ${rows.length ? `#${rows[0].seq}–#${last} of ${t.last_seq}` : 'no messages yet'}.${left ? ` ${left} more unread: call read_messages again.` : ''}`);
        if (t.summary && t.summary_at > rs.summary_seen) {
          out.push(`Summary of the topic (updated ${fmtTime(t.summary_at)}):\n${t.summary}`);
          markSummarySeen('a', agent.id, t.id, t.summary_at);
        }
      }
      if (rows.length && rows[0].seq > 1) out.push(`Older messages: before_seq=${rows[0].seq}.`);
      out.push(...rows.map(formatMessage));
      return out.join('\n\n');
    }

    case 'mark_read': {
      const t = resolveTopic(pid, args.topic);
      markRead('a', agent.id, t.id, Math.min(Number(args.seq) || 0, t.last_seq));
      return `Marked ${topicPath(t)} read up to #${Math.min(Number(args.seq) || 0, t.last_seq)}.`;
    }

    case 'post': {
      const t = resolveTopic(pid, args.topic);
      const body = String(args.body ?? '').trim();
      if (!body) fail('Empty body.');
      const before = unread('a', agent.id, t.id);
      const { seq } = postMessage(t.id, me, { body, to: Array.isArray(args.to) ? args.to : [], replyTo: args.reply_to_seq || null });
      if (!before.n) markRead('a', agent.id, t.id, seq);
      return `Posted #${seq} in ${topicPath(t)}.${before.n ? ` ${before.n} unread message${before.n === 1 ? '' : 's'} came before it: read them with read_messages before you post again.` : ''}`;
    }

    case 'list_members': {
      const t = resolveTopic(pid, args.topic);
      const people = all(`SELECT u.username, m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.username`, pid);
      const inTopic = new Set(all('SELECT agent_id FROM agent_topics WHERE topic_id=?', t.id).map((r) => r.agent_id));
      const agents = all(`SELECT a.*, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.project_id=? AND a.active=1 ORDER BY u.username, a.name`, pid);
      const lines = [`Members of ${topicPath(t)} (t${t.id}).`, 'People:'];
      for (const p of people) lines.push(`- @${p.username}${p.role === 'owner' ? ' (project owner)' : ''}`);
      lines.push('Agents in this topic:');
      const fmt = (a) => `- @${a.owner}/${a.name} (owner ${a.owner}, ${a.platform || 'agent'}): ${agentState(a)}${a.approval && agentState(a) !== 'offline' ? `, waiting for its owner's approval` : ''}. Task: ${a.task || 'none'}`;
      const inside = agents.filter((a) => inTopic.has(a.id)), outside = agents.filter((a) => !inTopic.has(a.id));
      lines.push(...(inside.length ? inside.map(fmt) : ['- none']));
      if (outside.length) lines.push('Other agents in the project (they wake only when mentioned):', ...outside.map(fmt));
      const r = roundInfo(t.id);
      if (r) lines.push(`A round is running: ${r.done}/${r.woken} woken agents have ended their turn.`);
      return lines.join('\n');
    }

    case 'set_task': {
      const task = String(args.task ?? '').trim().slice(0, 200);
      run('UPDATE agents SET task=? WHERE id=?', task, agent.id);
      ctx.emit?.();
      return `Task set: ${task || 'none'}.`;
    }

    case 'memory_index': {
      resolveTopic(pid, args.topic);
      const q = args.query ? `%${args.query}%` : '%';
      const rows = all('SELECT name, description, corrects FROM memory WHERE project_id=? AND (name LIKE ? OR description LIKE ? OR body LIKE ?) ORDER BY created DESC', pid, q, q, q);
      run('UPDATE agents SET memory_checked=? WHERE id=?', now(), agent.id);
      if (!rows.length) return args.query ? `No memory entries match "${args.query}".` : 'No memory entries yet.';
      return rows.map((r) => `- ${r.name}: ${r.description}${r.corrects ? ` (corrects ${r.corrects})` : ''}`).join('\n');
    }

    case 'memory_get': {
      resolveTopic(pid, args.topic);
      const m = get('SELECT * FROM memory WHERE project_id=? AND name=?', pid, String(args.name || '').trim());
      run('UPDATE agents SET memory_checked=? WHERE id=?', now(), agent.id);
      if (!m) fail(`No memory entry "${args.name}". Call memory_index for the names.`);
      const t = topicRow(m.topic_id);
      const by = m.agent_id ? `${username(m.user_id)}/${get('SELECT name FROM agents WHERE id=?', m.agent_id)?.name}` : username(m.user_id);
      const lines = [`${m.name}: ${m.description}`, `Written by ${by} on ${fmtTime(m.created)}${t ? ` in ${topicPath(t)}` : ''}.`, '', m.body];
      const sources = JSON.parse(m.sources || '[]');
      if (sources.length && t) {
        lines.push('', 'Sources:');
        for (const s of all(`${MSG_SELECT} WHERE m.topic_id=? AND m.seq IN (${sources.map(() => '?').join(',')}) ORDER BY m.seq`, t.id, ...sources))
          lines.push(`#${s.seq} ${s.agent_id ? `${s.owner}/${s.agent_name}` : s.author}: ${String(s.body).slice(0, 300)}`);
      }
      const links = JSON.parse(m.links || '[]');
      if (links.length) lines.push('', `Links: ${links.join(', ')}`);
      if (m.corrects) lines.push(`Corrects: ${m.corrects}`);
      const corrections = all('SELECT name, description FROM memory WHERE project_id=? AND corrects=?', pid, m.name);
      if (corrections.length) lines.push('', 'Corrected by:', ...corrections.map((c) => `- ${c.name}: ${c.description}`));
      return lines.join('\n');
    }

    case 'memory_write': {
      const t = resolveTopic(pid, args.topic);
      memoryGate(agent);
      const mname = String(args.name || '').trim();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(mname) || mname.length > 80) fail('name: lowercase words joined by -, up to 80 characters.');
      const desc = String(args.description || '').trim();
      if (!desc || desc.length > 200) fail('description: one sentence, at most 200 characters.');
      const body = String(args.body || '').trim();
      if (!body) fail('Empty body.');
      if (get('SELECT 1 FROM memory WHERE project_id=? AND name=?', pid, mname)) fail(`Entry "${mname}" exists. Entries are written once: write a new entry with corrects: "${mname}" to correct it.`);
      const sources = (Array.isArray(args.sources) ? args.sources : []).map(Number).filter((n) => n > 0 && n <= t.last_seq);
      const links = (Array.isArray(args.links) ? args.links : []).map(String);
      const corrects = args.corrects ? String(args.corrects) : null;
      if (corrects && !get('SELECT 1 FROM memory WHERE project_id=? AND name=?', pid, corrects)) fail(`No entry "${corrects}" to correct.`);
      const at = now();
      run('INSERT INTO memory(project_id, topic_id, name, description, body, sources, links, corrects, user_id, agent_id, created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        pid, t.id, mname, desc, body, JSON.stringify(sources), JSON.stringify(links), corrects, agent.user_id, agent.id, at);
      run('UPDATE agents SET memory_checked=? WHERE id=?', at, agent.id);
      run(`UPDATE proposals SET done=1 WHERE project_id=? AND done=0 AND json_extract(ranked, '$[' || idx || ']')=?`, pid, agent.id);
      postMessage(t.id, me, { body: `memory entry "${mname}" written: ${desc}`, kind: 'system', wake: false });
      const missing = links.filter((l) => !get('SELECT 1 FROM memory WHERE project_id=? AND name=?', pid, l));
      return `Wrote memory entry "${mname}".${missing.length ? ` These links name no entry yet: ${missing.join(', ')}.` : ''}`;
    }

    case 'memory_propose': {
      const t = resolveTopic(pid, args.topic);
      const seqs = [...new Set((Array.isArray(args.message_seqs) ? args.message_seqs : []).map(Number).filter((n) => n > 0 && n <= t.last_seq))];
      if (!seqs.length) fail('message_seqs: give the seqs of the messages the entry comes from.');
      const ph = seqs.map(() => '?').join(',');
      const agents = all(`SELECT a.*, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.project_id=? AND a.active=1`, pid);
      const scored = agents.map((a) => {
        const authored = get(`SELECT COUNT(*) AS n FROM messages WHERE topic_id=? AND agent_id=? AND seq IN (${ph})`, t.id, a.id, ...seqs).n;
        const nearby = get('SELECT COUNT(*) AS n FROM messages WHERE topic_id=? AND agent_id=? AND seq BETWEEN ? AND ?', t.id, a.id, Math.min(...seqs) - 10, Math.max(...seqs) + 10).n;
        const readAll = readSeq('a', a.id, t.id).seq >= Math.max(...seqs) ? 1 : 0;
        const joined = get('SELECT 1 FROM agent_topics WHERE agent_id=? AND topic_id=?', a.id, t.id) ? 1 : 0;
        const up = agentState(a) === 'offline' ? 0 : 1;
        return { a, score: up * 1000 + authored * 20 + nearby * 3 + readAll * 2 + joined };
      }).sort((x, y) => y.score - x.score);
      const id = `p_${randomBytes(4).toString('hex')}`;
      const ranked = scored.map((s) => s.a.id);
      run('INSERT INTO proposals(id, project_id, topic_id, seqs, ranked, idx, assigned_at, created) VALUES(?,?,?,?,?,0,?,?)', id, pid, t.id, JSON.stringify(seqs), JSON.stringify(ranked), now(), now());
      const chosen = scored[0].a;
      const ask = `You were chosen to write a memory entry from ${topicPath(t)} (t${t.id}) messages ${seqs.map((x) => `#${x}`).join(', ')}, proposal ${id}. Read them, then write it with memory_write if they pass the memory test, or call memory_object with proposal_id ${id}.`;
      if (chosen.id === agent.id) return `Proposal ${id}: you hold the most context. ${ask.replace('You were chosen to', 'So')}`;
      wakeDirect(chosen.id, ask);
      return `Proposal ${id}: asked @${chosen.owner}/${chosen.name} to write it.`;
    }

    case 'memory_object': {
      const p = get('SELECT * FROM proposals WHERE id=? AND project_id=?', String(args.proposal_id || ''), pid);
      if (!p) fail(`No proposal ${args.proposal_id}.`);
      const ranked = JSON.parse(p.ranked);
      if (p.done) fail('That proposal is already done.');
      if (ranked[p.idx] !== agent.id) fail('That proposal is not assigned to you.');
      if (p.objected) fail('This proposal already had its objection. Write the entry, or leave it.');
      if (now() - p.assigned_at > 60000) fail('Objections close 60 s after the proposal reached you. Write the entry, or leave it.');
      const next = ranked[p.idx + 1];
      if (!next) { run('UPDATE proposals SET done=1 WHERE id=?', p.id); return 'No other agent can take it. The proposal is closed.'; }
      run('UPDATE proposals SET idx=idx+1, objected=1, assigned_at=? WHERE id=?', now(), p.id);
      const t = topicRow(p.topic_id);
      const n = get('SELECT a.name, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.id=?', next);
      wakeDirect(next, `You were chosen to write a memory entry from ${topicPath(t)} (t${t.id}) messages ${JSON.parse(p.seqs).map((x) => `#${x}`).join(', ')}, proposal ${p.id}, after another agent passed it on. Write it with memory_write if the messages pass the memory test; otherwise leave it.`);
      return `Handed proposal ${p.id} to @${n.owner}/${n.name}.`;
    }

    case 'conclude': {
      const t = resolveTopic(pid, args.topic);
      const kind = args.kind === 'request' ? 'request' : args.kind === 'decision' ? 'decision' : fail('kind: decision or request.');
      if (kind === 'decision') memoryGate(agent);
      const text = String(args.text || '').trim();
      if (!text) fail('Empty text.');
      const to = Array.isArray(args.to) ? args.to.map(String) : [];
      if (kind === 'request' && !to.length) fail('A request needs the people it asks in "to".');
      const seqs = (Array.isArray(args.message_seqs) ? args.message_seqs : []).map(Number).filter((n) => n > 0);
      const { seq } = postMessage(t.id, me, { body: text, to, kind, meta: { seqs } });
      markRead('a', agent.id, t.id, seq);
      return `Posted ${kind} #${seq} in ${topicPath(t)}.`;
    }

    case 'skill_get': {
      const s = get('SELECT * FROM skills WHERE project_id=? AND name=? COLLATE NOCASE', pid, String(args.name || '').trim());
      if (!s) fail(`No skill "${args.name}". status lists the project's skills.`);
      const files = all('SELECT path, length(content) AS size FROM skill_files WHERE skill_id=? ORDER BY path', s.id);
      return [`Skill ${s.name}: ${s.description}`, '', s.body, ...(files.length ? ['', 'Files (read with skill_file):', ...files.map((f) => `- ${f.path} (${fmtSize(f.size)})`)] : [])].join('\n');
    }

    case 'skill_file': {
      const s = get('SELECT * FROM skills WHERE project_id=? AND name=? COLLATE NOCASE', pid, String(args.name || '').trim());
      if (!s) fail(`No skill "${args.name}".`);
      const f = get('SELECT content FROM skill_files WHERE skill_id=? AND path=?', s.id, String(args.path || ''));
      if (!f) fail(`Skill ${s.name} has no file "${args.path}".`);
      return f.content;
    }

    case 'list_files': {
      const t = resolveTopic(pid, args.topic);
      const rows = all(`SELECT f.*, u.username AS uploader, a.name AS agent_name, (SELECT seq FROM messages WHERE file_id=f.id) AS seq FROM files f LEFT JOIN users u ON u.id=f.user_id LEFT JOIN agents a ON a.id=f.agent_id WHERE f.topic_id=? ORDER BY f.id DESC`, t.id);
      if (!rows.length) return `No files in ${topicPath(t)}.`;
      return [`Files in ${topicPath(t)}, newest first. Download one with: weclaude download <file id> <path>`, ...rows.map((f) => `- f${f.id} "${f.name}" ${fmtSize(f.size)} by ${f.agent_name ? `${f.uploader}/${f.agent_name}` : f.uploader}${f.seq ? ` in #${f.seq}` : ''}, ${fmtTime(f.created)}`)].join('\n');
    }
  }
}

// One JSON-RPC request. Returns the reply object, or null for a notification.
export function handleRpc(ctx, msg) {
  const id = msg?.id;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid request');
  if (id === undefined) return null;
  switch (msg.method) {
    case 'initialize': return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    case 'tools/call': {
      if (!ctx.user) return reply({ content: [{ type: 'text', text: 'Not signed in. Run /weclaude:login (or: weclaude login).' }], isError: true });
      try {
        const text = callTool(ctx, msg.params?.name, msg.params?.arguments || {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(e);
        return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Server error: ${e.message}` }], isError: true });
      }
    }
    default: return error(-32601, `Method not found: ${msg.method}`);
  }
}
