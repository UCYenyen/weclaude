// Messages, mentions, rounds and wakes.
//
// Rounds: a post in a topic gives each recipient agent a pending wake for that topic. When the topic has no
// round running, a round starts: every recipient that is online gets one wake line. Posts made during the
// round wait. The round ends when every woken agent has ended its turn, or after the project's round limit,
// and then the waiting posts start the next round.
import { EventEmitter } from 'node:events';
import { all, get, run, now, tx, topicRow, topicPath, username } from './db.js';

export const bus = new EventEmitter(); // web live updates: emit('project:<id>', event)
bus.setMaxListeners(0);
export const emitProject = (projectId, ev) => bus.emit(`project:${projectId}`, ev);
export const emitUser = (userId, ev) => bus.emit(`user:${userId}`, ev);

const OFFLINE_THINKING_MS = 15 * 60 * 1000;

const watchers = new Map();   // agentId -> Set<{write(line), once}>
const released = new Map();   // agentId -> Map<topicId, {n, mention}>, wakes ready to deliver
const directLines = new Map();// agentId -> string[]: wakes outside rounds (memory proposals)
const pending = new Map();    // topicId -> Map<agentId, {n, mention}>, waiting for the next round
const rounds = new Map();     // topicId -> {woken:Set, delivered:Map<agentId,ms>, done:Set, timer, start}

const agentRow = (id) => get('SELECT a.*, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.id=?', id);

export function agentState(a) {
  if (!a || !a.active) return 'offline';
  if (watchers.get(a.id)?.size) return a.state === 'thinking' && now() - a.state_at < OFFLINE_THINKING_MS ? 'thinking' : 'idle';
  if (a.state === 'thinking' && now() - a.state_at < OFFLINE_THINKING_MS) return 'thinking';
  return 'offline';
}
const online = (a) => agentState(a) !== 'offline';

// ---------- mentions ----------
// @username is a person, @owner/name an agent. A bare name that is no person but one agent's name means that agent.
export function resolveMentions(projectId, body, to = []) {
  const found = { users: new Set(), agents: new Set() };
  const tokens = [];
  for (const m of String(body || '').matchAll(/(?:^|[^\w@/])@([a-z0-9][\w.-]*)(?:\/([a-z0-9][a-z0-9-]*))?/gi)) tokens.push([m[1], m[2]]);
  for (const t of to || []) {
    const s = String(t).trim().replace(/^@/, '');
    if (s) tokens.push(s.split('/', 2));
  }
  for (const [rawUser, name] of tokens) {
    const user = rawUser.replace(/[.]+$/, '');
    if (name) {
      const a = get(`SELECT a.id FROM agents a JOIN users u ON u.id=a.user_id WHERE a.project_id=? AND a.active=1 AND u.username=? COLLATE NOCASE AND a.name=?`, projectId, user, name.toLowerCase());
      if (a) found.agents.add(a.id);
      continue;
    }
    const u = get(`SELECT u.id FROM users u JOIN project_members m ON m.user_id=u.id WHERE m.project_id=? AND u.username=? COLLATE NOCASE`, projectId, user);
    if (u) { found.users.add(u.id); continue; }
    const as = all('SELECT id FROM agents WHERE project_id=? AND active=1 AND name=?', projectId, user.toLowerCase());
    if (as.length === 1) found.agents.add(as[0].id);
  }
  return found;
}

// ---------- posting ----------
// Adds a message to a topic and wakes whoever it concerns. author: {userId, agentId|null}.
export function postMessage(topicId, author, { body = '', to = [], replyTo = null, kind = 'message', fileId = null, meta = null, wake = true }) {
  const t = topicRow(topicId);
  const mentions = resolveMentions(t.project_id, body, to);
  const msg = tx(() => {
    const seq = get('UPDATE topics SET last_seq=last_seq+1 WHERE id=? RETURNING last_seq', topicId).last_seq;
    run(`INSERT INTO messages(topic_id, seq, user_id, agent_id, kind, body, to_, reply_to, file_id, meta, created) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      topicId, seq, author.userId ?? null, author.agentId ?? null, kind, body, JSON.stringify(to || []), replyTo, fileId, meta ? JSON.stringify(meta) : null, now());
    for (const u of mentions.users) run('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)', topicId, seq, 'u', u);
    for (const a of mentions.agents) run('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)', topicId, seq, 'a', a);
    return { seq };
  });
  const authorName = author.agentId ? `${username(author.userId)}/${agentRow(author.agentId)?.name}` : username(author.userId);
  // People: a mention notifies them, and so does a conclusion addressed to them.
  const notify = new Set(mentions.users);
  if (kind === 'decision') for (const m of all('SELECT user_id FROM project_members WHERE project_id=?', t.project_id)) notify.add(m.user_id);
  for (const u of notify) {
    if (u === author.userId && !author.agentId) continue;
    const text = kind === 'decision' ? `Decision in ${topicPath(t)}: ${body}` : kind === 'request' ? `Request in ${topicPath(t)} from ${authorName}: ${body}` : `${authorName} mentioned you in ${topicPath(t)}: ${body}`;
    addNotification(u, t.project_id, topicId, msg.seq, text);
  }
  emitProject(t.project_id, { type: 'message', topic: topicId, seq: msg.seq });
  if (wake) {
    const recipients = new Map();
    for (const r of all('SELECT at.agent_id FROM agent_topics at JOIN agents a ON a.id=at.agent_id WHERE at.topic_id=? AND a.active=1', topicId)) recipients.set(r.agent_id, false);
    for (const a of mentions.agents) recipients.set(a, true);
    recipients.delete(author.agentId);
    queueWakes(topicId, recipients);
  }
  return msg;
}

export function addNotification(userId, projectId, topicId, seq, text) {
  const id = run('INSERT INTO notifications(user_id, project_id, topic_id, seq, text, created) VALUES(?,?,?,?,?,?)', userId, projectId, topicId, seq, String(text).slice(0, 500), now()).lastInsertRowid;
  emitUser(userId, { type: 'notification', id: Number(id), text, project: projectId, topic: topicId, seq });
}

// ---------- rounds ----------
function queueWakes(topicId, recipients) {
  let p = pending.get(topicId);
  if (!p) pending.set(topicId, (p = new Map()));
  for (const [agentId, mention] of recipients) {
    const a = agentRow(agentId);
    if (!online(a)) continue; // an offline agent reads its unread messages when its session starts again
    const cur = p.get(agentId) || { n: 0, mention: false };
    p.set(agentId, { n: cur.n + 1, mention: cur.mention || mention });
  }
  if (!rounds.has(topicId)) startRound(topicId);
}

function startRound(topicId) {
  const p = pending.get(topicId);
  pending.delete(topicId);
  if (!p || !p.size) return;
  const t = topicRow(topicId);
  if (!t) return;
  const limit = get('SELECT round_ms FROM projects WHERE id=?', t.project_id)?.round_ms || 120000;
  const round = { woken: new Set(), delivered: new Map(), done: new Set(), start: now() };
  round.timer = setTimeout(() => endRound(topicId), limit);
  rounds.set(topicId, round);
  for (const [agentId, w] of p) {
    round.woken.add(agentId);
    let r = released.get(agentId);
    if (!r) released.set(agentId, (r = new Map()));
    const cur = r.get(topicId) || { n: 0, mention: false };
    r.set(topicId, { n: cur.n + w.n, mention: cur.mention || w.mention });
  }
  for (const agentId of round.woken) tryDeliver(agentId);
}

function endRound(topicId) {
  const r = rounds.get(topicId);
  if (!r) return;
  clearTimeout(r.timer);
  rounds.delete(topicId);
  startRound(topicId);
}

// The agent ended a turn: it reported idle, or opened a new wake stream.
export function turnEnded(agentId) {
  const t = now();
  for (const [topicId, r] of rounds) {
    const d = r.delivered.get(agentId);
    if (d !== undefined && t > d + 500) r.done.add(agentId);
    // An agent that went offline will not end its turn.
    for (const id of r.woken) if (!r.done.has(id) && !online(agentRow(id))) r.done.add(id);
    if ([...r.woken].every((id) => r.done.has(id))) endRound(topicId);
  }
  tryDeliver(agentId);
}

function wakeLine(agentId) {
  const parts = [];
  const r = released.get(agentId);
  if (r) for (const [topicId, w] of r) {
    const t = topicRow(topicId);
    if (!t) continue;
    parts.push(`${w.n} new message${w.n === 1 ? '' : 's'} in ${topicPath(t)} (t${t.id})${w.mention ? ', mentioning you' : ''}`);
  }
  const lines = directLines.get(agentId) || [];
  const text = [parts.length ? `${parts.join('; ')}.` : '', ...lines].filter(Boolean).join(' ');
  return text ? `Weclaude: ${text}` : '';
}

// Sends the agent its waiting wakes, when it has a wake stream open and is not in a turn.
export function tryDeliver(agentId) {
  const ws = watchers.get(agentId);
  if (!ws?.size) return;
  const a = agentRow(agentId);
  if (!a?.active) return;
  if (a.state === 'thinking' && now() - a.state_at < OFFLINE_THINKING_MS) return;
  const line = wakeLine(agentId);
  if (!line) return;
  const topics = [...(released.get(agentId)?.keys() || [])];
  released.delete(agentId);
  directLines.delete(agentId);
  for (const w of ws) w.write(line);
  const t = now();
  for (const topicId of topics) rounds.get(topicId)?.delivered.set(agentId, t);
  // The client starts a turn on this line, so count the agent as thinking until it says otherwise.
  run(`UPDATE agents SET state='thinking', state_at=? WHERE id=?`, t, agentId);
  emitProject(a.project_id, { type: 'agents' });
}

export function wakeDirect(agentId, text) {
  const l = directLines.get(agentId) || [];
  l.push(text);
  directLines.set(agentId, l);
  tryDeliver(agentId);
}

export function addWatcher(agentId, w) {
  let s = watchers.get(agentId);
  if (!s) watchers.set(agentId, (s = new Set()));
  s.add(w);
  const a = agentRow(agentId);
  emitProject(a.project_id, { type: 'agents' });
  turnEnded(agentId);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    s.delete(w);
    if (!s.size && watchers.get(agentId) === s) watchers.delete(agentId);
    const b = agentRow(agentId);
    if (b) emitProject(b.project_id, { type: 'agents' });
  };
}

// Drops an agent's queued wakes, when it leaves a topic or the project.
export function forgetAgent(agentId, topicId = null) {
  if (topicId == null) { released.delete(agentId); directLines.delete(agentId); }
  else released.get(agentId)?.delete(topicId);
  for (const [tid, p] of pending) if (topicId == null || tid === topicId) p.delete(agentId);
  for (const [tid, r] of rounds) if (topicId == null || tid === topicId) { r.done.add(agentId); if ([...r.woken].every((id) => r.done.has(id))) endRound(tid); }
}

export function roundInfo(topicId) {
  const r = rounds.get(topicId);
  return r ? { since: r.start, woken: r.woken.size, done: r.done.size } : null;
}

// Retries wakes held back by a stale thinking state, and ends rounds whose agents went offline.
setInterval(() => {
  for (const agentId of released.keys()) tryDeliver(agentId);
  for (const agentId of directLines.keys()) tryDeliver(agentId);
  for (const [topicId, r] of rounds) {
    for (const id of r.woken) if (!r.done.has(id) && !online(agentRow(id))) r.done.add(id);
    if ([...r.woken].every((id) => r.done.has(id))) endRound(topicId);
  }
}, 30000).unref();
