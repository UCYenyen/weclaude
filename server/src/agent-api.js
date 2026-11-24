// Routes the weclaude client script calls: device sign-in, join/topic/leave/rename, state, watch, upload, MCP.
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { writeFile } from 'node:fs/promises';
import { all, get, run, now, tx, sha256, randomToken, topicPath, username, DATA_DIR } from './db.js';
import { handleRpc, resolveTopic, projectTopics, statusText, ToolError } from './mcp.js';
import { postMessage, addWatcher, turnEnded, forgetAgent, emitProject, addNotification, agentState } from './core.js';

export const api = new Hono();
const PUBLIC_URL = () => process.env.PUBLIC_URL || '';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 50) * 1048576;

// The device behind a bearer token, or null.
export function deviceUser(c) {
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(\S+)/i);
  if (!m) return null;
  const d = get('SELECT d.id, d.user_id, u.username FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND d.revoked=0', sha256(m[1]));
  if (!d) return null;
  run('UPDATE devices SET last_used=? WHERE id=?', now(), d.id);
  return { id: d.user_id, username: d.username, deviceId: d.id };
}
const sessionOf = (c) => (c.req.header('x-weclaude-session') || '').trim().slice(0, 200);
export const sessionAgent = (userId, session) => session ? get(`SELECT a.*, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.session=? AND a.active=1`, userId, session) : null;

const text = (c, body, status = 200) => c.text(body.endsWith('\n') ? body : `${body}\n`, status);

// Every agent route below needs a signed-in device and, except logout, a session id.
function auth(c, needSession = true) {
  const user = deviceUser(c);
  if (!user) return { err: text(c, 'Not signed in or the sign-in was revoked. Run: weclaude login', 401) };
  const session = sessionOf(c);
  if (needSession && !session) return { err: text(c, 'No session id (set WECLAUDE_SESSION).', 400) };
  const agent = sessionAgent(user.id, session);
  if (agent) run('UPDATE agents SET version=? WHERE id=?', (c.req.header('x-weclaude-version') || '').slice(0, 20), agent.id);
  return { user, session, agent };
}

// ---------- device sign-in ----------
api.post('/device/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
  const poll = randomToken(24);
  run('DELETE FROM device_logins WHERE expires<?', now());
  run('INSERT INTO device_logins(code, poll, name, expires) VALUES(?,?,?,?)', code, poll, String(body.name || 'device').slice(0, 80), now() + 10 * 60000);
  return c.json({ url: `${PUBLIC_URL()}/device?code=${code}`, poll, code });
});

api.post('/device/poll', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const l = get('SELECT * FROM device_logins WHERE poll=?', String(body.poll || ''));
  if (!l || l.expires < now()) return c.text('expired', 410);
  if (!l.token) return c.text('waiting', 202);
  run('DELETE FROM device_logins WHERE poll=?', l.poll);
  return c.text(l.token, 200);
});

api.post('/device/logout', (c) => {
  const user = deviceUser(c);
  if (user) run('UPDATE devices SET revoked=1 WHERE id=?', user.deviceId);
  return c.text('Signed out\n');
});

// Called by the web approval page.
export function approveDevice(code, userId) {
  const l = get('SELECT * FROM device_logins WHERE code=? AND expires>?', code, now());
  if (!l || l.token) return null;
  const token = `wc_${randomToken(32)}`;
  run('INSERT INTO devices(user_id, name, token_hash, created) VALUES(?,?,?,?)', userId, l.name, sha256(token), now());
  run('UPDATE device_logins SET token=?, user_id=? WHERE code=?', token, userId, code);
  return l.name;
}

// ---------- membership ----------
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

function topicList(projectId) {
  const ts = projectTopics(projectId);
  return ts.length ? ts.map((t) => `- ${t.group_name}/${t.name} (t${t.id})`).join('\n') : '- none yet: create groups and topics on the web';
}

api.post('/agent/join', async (c) => {
  const { user, session, agent, err } = auth(c);
  if (err) return err;
  const body = await c.req.json().catch(() => ({}));
  const pname = String(body.project || '').trim();
  const p = get('SELECT * FROM projects WHERE name=?', pname);
  if (!p) return text(c, `No project "${pname}". Create it at ${PUBLIC_URL()}/ or ask its owner for the exact name.`, 404);
  if (!get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', p.id, user.id)) return text(c, `You (${user.username}) are not a member of ${p.name}. Ask its owner to add you on the web.`, 403);
  const name = String(body.name || '').trim().toLowerCase();
  if (agent) {
    if (agent.project_id !== p.id) return text(c, `This session already joined ${get('SELECT name FROM projects WHERE id=?', agent.project_id).name} as ${user.username}/${agent.name}. Run: weclaude leave --project, first.`, 409);
    if (name && name !== agent.name) return text(c, `This session already joined ${p.name} as ${user.username}/${agent.name}. Rename it with: weclaude rename <name>`, 409);
    return text(c, `Already joined ${p.name} as ${user.username}/${agent.name}.\nTopics:\n${topicList(p.id)}\n\n${statusText(agent)}`);
  }
  if (!NAME_RE.test(name)) return text(c, 'Name refused: use lowercase letters, digits and -, up to 40 characters, starting and ending with a letter or digit.', 400);
  const existing = get('SELECT a.*, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.project_id=? AND a.user_id=? AND a.name=?', p.id, user.id, name);
  const t = now();
  let id;
  if (existing) {
    if (existing.active && existing.session && existing.session !== session && agentState(existing) !== 'offline')
      return text(c, `Name refused: ${user.username}/${name} is in use by another online session. Pick another name.`, 409);
    run(`UPDATE agents SET session=?, active=1, platform=?, model=?, state='idle', state_at=?, session_started=?, approval=NULL WHERE id=?`, session, String(body.platform || ''), String(body.model || ''), t, t, existing.id);
    id = existing.id;
  } else {
    id = Number(run(`INSERT INTO agents(user_id, project_id, session, name, platform, model, state, state_at, session_started, created) VALUES(?,?,?,?,?,?, 'idle', ?, ?, ?)`, user.id, p.id, session, name, String(body.platform || ''), String(body.model || ''), t, t, t).lastInsertRowid);
  }
  emitProject(p.id, { type: 'agents' });
  const a = sessionAgent(user.id, session);
  const back = existing ? ' It keeps the topics and read state it had.' : '';
  return text(c, `Joined ${p.name} as ${user.username}/${name}.${back}\nTopics in the project:\n${topicList(p.id)}\n\n${statusText(a)}`);
});

api.post('/agent/topic', async (c) => {
  const { agent, err } = auth(c);
  if (err) return err;
  if (!agent) return text(c, 'This session has not joined a project. Run: weclaude join <project>', 409);
  const body = await c.req.json().catch(() => ({}));
  try {
    const t = resolveTopic(agent.project_id, body.topic);
    run('INSERT OR IGNORE INTO agent_topics VALUES(?,?)', agent.id, t.id);
    emitProject(agent.project_id, { type: 'agents' });
    const n = get(`SELECT COUNT(*) AS n FROM messages WHERE topic_id=? AND seq>(SELECT IFNULL(MAX(seq),0) FROM reads WHERE kind='a' AND who=? AND topic_id=?)`, t.id, agent.id, t.id).n;
    return text(c, `Joined ${topicPath(t)} (t${t.id}). ${n} unread.`);
  } catch (e) { if (e instanceof ToolError) return text(c, e.message, 404); throw e; }
});

api.post('/agent/leave', async (c) => {
  const { user, agent, err } = auth(c);
  if (err) return err;
  if (!agent) return text(c, 'This session has not joined a project.', 409);
  const body = await c.req.json().catch(() => ({}));
  const pname = get('SELECT name FROM projects WHERE id=?', agent.project_id).name;
  if (!body.topic) {
    run(`UPDATE agents SET active=0, session=NULL, state='idle', approval=NULL WHERE id=?`, agent.id);
    forgetAgent(agent.id);
    emitProject(agent.project_id, { type: 'agents' });
    return text(c, `Left ${pname}. ${user.username}/${agent.name} keeps its topics and read state if it joins again under that name.`);
  }
  try {
    const t = resolveTopic(agent.project_id, body.topic);
    run('DELETE FROM agent_topics WHERE agent_id=? AND topic_id=?', agent.id, t.id);
    forgetAgent(agent.id, t.id);
    emitProject(agent.project_id, { type: 'agents' });
    return text(c, `Left ${topicPath(t)}. Mentions there still wake you.`);
  } catch (e) { if (e instanceof ToolError) return text(c, e.message, 404); throw e; }
});

api.post('/agent/rename', async (c) => {
  const { user, agent, err } = auth(c);
  if (err) return err;
  if (!agent) return text(c, 'This session has not joined a project.', 409);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return text(c, 'Name refused: use lowercase letters, digits and -, up to 40 characters.', 400);
  if (get('SELECT 1 FROM agents WHERE project_id=? AND user_id=? AND name=? AND id<>?', agent.project_id, user.id, name, agent.id)) return text(c, `Name refused: you already have an agent named ${name} in this project.`, 409);
  run('UPDATE agents SET name=? WHERE id=?', name, agent.id);
  emitProject(agent.project_id, { type: 'agents' });
  return text(c, `Renamed ${user.username}/${agent.name} to ${user.username}/${name}.`);
});

// ---------- turn state ----------
api.post('/agent/state', async (c) => {
  const { user, agent, err } = auth(c);
  if (err) return err;
  if (!agent) return c.body(null, 204);
  const body = await c.req.json().catch(() => ({}));
  const state = body.state === 'thinking' ? 'thinking' : 'idle';
  const approval = body.approval ? String(body.approval).slice(0, 500) : null;
  run('UPDATE agents SET state=?, state_at=?, approval=? WHERE id=?', state, now(), approval, agent.id);
  if (approval) addNotification(user.id, agent.project_id, null, null, `${user.username}/${agent.name} waits for your approval: ${approval}`);
  emitProject(agent.project_id, { type: 'agents' });
  if (state === 'idle') turnEnded(agent.id);
  return c.body(null, 204);
});

// The wake stream: one "data: <line>" per wake. 204 when the session joined no project, so the client stops.
api.get('/agent/watch', (c) => {
  const { agent, err } = auth(c);
  if (err) return err;
  if (!agent) return c.body(null, 204);
  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return stream(c, async (s) => {
    let closed = false, remove = () => {};
    s.onAbort(() => { closed = true; remove(); });
    await s.write(': connected\n\n');
    if (closed) return;
    remove = addWatcher(agent.id, { write: (line) => { if (!closed) s.write(`data: ${line.replace(/\n/g, ' ')}\n\n`).catch(() => { closed = true; }); } });
    try {
      // Pings keep proxies from closing an idle stream. Leaving the project ends it.
      while (!closed) {
        await s.sleep(20000);
        if (closed) break;
        if (!get('SELECT 1 FROM agents WHERE id=? AND active=1', agent.id)) break;
        await s.write(': ping\n\n').catch(() => { closed = true; });
      }
    } finally { remove(); }
  });
});

// ---------- files ----------
api.post('/agent/upload', async (c) => {
  const { user, agent, err } = auth(c);
  if (err) return err;
  if (!agent) return text(c, 'This session has not joined a project.', 409);
  const form = await c.req.parseBody();
  const file = form.file;
  if (!file || typeof file === 'string') return text(c, 'No file in the upload.', 400);
  if (file.size > MAX_UPLOAD) return text(c, `File too large: the limit is ${MAX_UPLOAD / 1048576} MB.`, 413);
  let t;
  try { t = resolveTopic(agent.project_id, form.topic); } catch (e) { if (e instanceof ToolError) return text(c, e.message, 404); throw e; }
  const { id, seq } = await saveUpload(t, file, { userId: user.id, agentId: agent.id }, String(form.text || ''));
  return text(c, `Uploaded "${file.name}" as file f${id}, posted #${seq} in ${topicPath(t)}.`);
});

export async function saveUpload(t, file, author, caption) {
  const name = String(file.name || 'file').replace(/[\/\\\0]/g, '_').slice(0, 200);
  const id = Number(run('INSERT INTO files(topic_id, project_id, name, size, mime, user_id, agent_id, created) VALUES(?,?,?,?,?,?,?,?)', t.id, t.project_id, name, file.size, file.type || 'application/octet-stream', author.userId, author.agentId ?? null, now()).lastInsertRowid);
  await writeFile(`${DATA_DIR}/files/${id}`, Buffer.from(await file.arrayBuffer()));
  const { seq } = postMessage(t.id, author, { body: caption.trim(), kind: 'file', fileId: id });
  return { id, seq };
}

api.post('/mcp', async (c) => {
  const user = deviceUser(c);
  const session = sessionOf(c);
  const agent = user ? sessionAgent(user.id, session) : null;
  let msg;
  try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const ctx = { user, agent, emit: () => agent && emitProject(agent.project_id, { type: 'agents' }) };
  if (Array.isArray(msg)) { const out = msg.map((m) => handleRpc(ctx, m)).filter(Boolean); return out.length ? c.json(out) : c.body(null, 202); }
  const out = handleRpc(ctx, msg);
  return out ? c.json(out) : c.body(null, 202);
});
