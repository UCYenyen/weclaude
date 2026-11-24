// The website people use: accounts, projects, device approval, and the JSON + live-update API of the chat page.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { Marked } from 'marked';
import { all, get, run, now, sha256, randomToken, hashPassword, checkPassword, topicRow, isMember, readSeq, markRead, unread, markSummarySeen } from './db.js';
import { postMessage, bus, emitProject, agentState, forgetAgent } from './core.js';
import { MSG_SELECT } from './mcp.js';
import { approveDevice, saveUpload } from './agent-api.js';

export const web = new Hono();
const SECURE = (process.env.PUBLIC_URL || '').startsWith('https://');
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// ---------- markdown ----------
const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html: ({ text }) => esc(text),
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:|\/|#)/i.test(href || '')) return inner;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image: ({ href, text }) => /^https?:/i.test(href || '') ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>` : esc(text),
  },
});
export function renderMarkdown(src) {
  const html = md.parse(String(src || ''));
  // Highlight @mentions outside tags and code.
  return html.split(/(<code[\s\S]*?<\/code>|<[^>]+>)/g).map((part) => part.startsWith('<') ? part
    : part.replace(/(^|[\s(>])@([a-z0-9][\w.-]*(?:\/[a-z0-9][a-z0-9-]*)?)/gi, '$1<span class="mention">@$2</span>')).join('');
}

// ---------- pages ----------
const page = (title, body, user) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · weclaude</title><link rel="stylesheet" href="/static/app.css"><link rel="icon" href="/static/icon.svg"></head>
<body class="page"><header class="top"><a class="brand" href="/">weclaude</a>${user ? `<nav><a href="/settings">${esc(user.username)}</a><form method="post" action="/logout"><button class="link">Sign out</button></form></nav>` : ''}</header>
<main class="narrow">${body}</main></body></html>`;

function currentUser(c) {
  const tok = getCookie(c, 'wc_session');
  if (!tok) return null;
  return get('SELECT u.id, u.username, u.admin FROM web_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', sha256(tok)) || null;
}
function startSession(c, userId) {
  const tok = randomToken(32);
  run('INSERT INTO web_sessions(token_hash, user_id, created) VALUES(?,?,?)', sha256(tok), userId, now());
  setCookie(c, 'wc_session', tok, { httpOnly: true, secure: SECURE, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 180 });
}
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');
const needLogin = (c) => c.redirect(`/login?next=${encodeURIComponent(c.req.path + (new URL(c.req.url).search || ''))}`);

const authForm = (kind, error = '', next = '/') => {
  const signup = kind === 'signup';
  return page(signup ? 'Create account' : 'Sign in', `<h1>${signup ? 'Create an account' : 'Sign in'}</h1>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" class="card form"><input type="hidden" name="next" value="${esc(next)}">
<label>Username<input name="username" autocomplete="username" required pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{1,30}" title="2–31 letters, digits, _ . -"></label>
<label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8"></label>
${signup && SIGNUP_CODE ? '<label>Invite code<input name="code" required></label>' : ''}
<button>${signup ? 'Create account' : 'Sign in'}</button></form>
<p class="muted">${signup ? `Have an account? <a href="/login?next=${encodeURIComponent(next)}">Sign in</a>` : `New here? <a href="/signup?next=${encodeURIComponent(next)}">Create an account</a>`}</p>`);
};

web.get('/login', (c) => c.html(authForm('login', '', safeNext(c.req.query('next')))));
web.post('/login', async (c) => {
  const f = await c.req.parseBody();
  const u = get('SELECT * FROM users WHERE username=?', String(f.username || '').trim());
  if (!u || !checkPassword(String(f.password || ''), u.pass)) return c.html(authForm('login', 'Wrong username or password.', safeNext(f.next)), 401);
  startSession(c, u.id);
  return c.redirect(safeNext(f.next));
});
web.get('/signup', (c) => c.html(authForm('signup', '', safeNext(c.req.query('next')))));
web.post('/signup', async (c) => {
  const f = await c.req.parseBody();
  const name = String(f.username || '').trim(), pass = String(f.password || '');
  const next = safeNext(f.next);
  if (SIGNUP_CODE && f.code !== SIGNUP_CODE) return c.html(authForm('signup', 'Wrong invite code.', next), 403);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,30}$/.test(name)) return c.html(authForm('signup', 'Username: 2–31 letters, digits, _ . -', next), 400);
  if (pass.length < 8) return c.html(authForm('signup', 'Password: at least 8 characters.', next), 400);
  if (get('SELECT 1 FROM users WHERE username=?', name)) return c.html(authForm('signup', 'That username is taken.', next), 409);
  const first = !get('SELECT 1 FROM users LIMIT 1');
  const id = Number(run('INSERT INTO users(username, pass, admin, created) VALUES(?,?,?,?)', name, hashPassword(pass), first ? 1 : 0, now()).lastInsertRowid);
  startSession(c, id);
  return c.redirect(next);
});
web.post('/logout', (c) => {
  const tok = getCookie(c, 'wc_session');
  if (tok) run('DELETE FROM web_sessions WHERE token_hash=?', sha256(tok));
  deleteCookie(c, 'wc_session', { path: '/' });
  return c.redirect('/login');
});

web.get('/', (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const projects = all(`SELECT p.*, m.role, (SELECT COUNT(*) FROM agents a WHERE a.project_id=p.id AND a.active=1) AS agents FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.name`, u.id);
  const err = c.req.query('error');
  return c.html(page('Projects', `<h1>Projects</h1>${err ? `<p class="error">${esc(err)}</p>` : ''}
<ul class="list card">${projects.map((p) => `<li><a href="/p/${encodeURIComponent(p.name)}"><b>${esc(p.name)}</b></a> <span class="muted">${p.role === 'owner' ? 'owner · ' : ''}${p.agents} agent${p.agents === 1 ? '' : 's'}</span></li>`).join('') || '<li class="muted">No projects yet.</li>'}</ul>
<h2>New project</h2><form method="post" action="/projects" class="card form row"><input name="name" placeholder="project-name" required pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{0,39}" title="letters, digits, _ . - (no spaces)"><button>Create</button></form>
<h2>Connect an agent</h2><div class="card prose">
<p>Install the plugin in Claude Code (the repo is private, so the machine needs GitHub access to <code>UCYenyen/weclaude</code>):</p>
<pre><code>claude plugin marketplace add UCYenyen/weclaude
claude plugin install weclaude@weclaude</code></pre>
<p>Then, in a Claude Code session: <code>/weclaude:login</code>, approve the link here, and <code>/weclaude:join &lt;project&gt;</code>.</p></div>`, u));
});

web.post('/projects', async (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const name = String((await c.req.parseBody()).name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(name)) return c.redirect('/?error=' + encodeURIComponent('Project name: letters, digits, _ . - (no spaces), up to 40.'));
  if (get('SELECT 1 FROM projects WHERE name=?', name)) return c.redirect('/?error=' + encodeURIComponent(`A project named ${name} exists.`));
  const pid = Number(run('INSERT INTO projects(name, owner_id, created) VALUES(?,?,?)', name, u.id, now()).lastInsertRowid);
  run("INSERT INTO project_members VALUES(?,?,'owner')", pid, u.id);
  const gid = Number(run('INSERT INTO groups_(project_id, name) VALUES(?,?)', pid, 'General').lastInsertRowid);
  run('INSERT INTO topics(group_id, project_id, name) VALUES(?,?,?)', gid, pid, 'Chat');
  return c.redirect(`/p/${encodeURIComponent(name)}`);
});

web.get('/p/:name', (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const p = get('SELECT * FROM projects WHERE name=?', c.req.param('name'));
  if (!p || !isMember(p.id, u.id)) return c.html(page('Not found', '<h1>No such project</h1><p>It does not exist, or you are not a member. <a href="/">Back</a></p>', u), 404);
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} · weclaude</title><link rel="stylesheet" href="/static/app.css"><link rel="icon" href="/static/icon.svg"></head>
<body class="app" data-project="${p.id}" data-me="${esc(u.username)}"><div id="root"><p class="muted" style="padding:2rem">Loading…</p></div>
<script src="/static/app.js" type="module"></script></body></html>`);
});

web.get('/device', (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const code = String(c.req.query('code') || '');
  const l = get('SELECT * FROM device_logins WHERE code=? AND expires>?', code, now());
  if (!l || l.token) return c.html(page('Sign-in link', '<h1>This link expired</h1><p>Run <code>weclaude login</code> again for a new one.</p>', u), 410);
  return c.html(page('Approve device', `<h1>Sign in a device?</h1><div class="card"><p>The machine <b>${esc(l.name)}</b> asks to sign in as <b>${esc(u.username)}</b>. Its agents will post and read in your projects as you.</p>
<p class="muted">Code ${esc(code)}. Approve only if you just ran <code>weclaude login</code>.</p>
<form method="post" class="row"><input type="hidden" name="code" value="${esc(code)}"><button>Approve</button><a class="button ghost" href="/">Cancel</a></form></div>`, u));
});
web.post('/device', async (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const name = approveDevice(String((await c.req.parseBody()).code || ''), u.id);
  return c.html(page('Device', name ? `<h1>Signed in</h1><p><b>${esc(name)}</b> is signed in. You can close this tab.</p>` : '<h1>This link expired</h1><p>Run <code>weclaude login</code> again.</p>', u));
});

web.get('/settings', (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const devices = all('SELECT * FROM devices WHERE user_id=? AND revoked=0 ORDER BY created DESC', u.id);
  const msg = c.req.query('msg');
  const d = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never');
  return c.html(page('Settings', `<h1>Settings</h1>${msg ? `<p class="notice">${esc(msg)}</p>` : ''}
<h2>Signed-in devices</h2><ul class="list card">${devices.map((x) => `<li><b>${esc(x.name)}</b> <span class="muted">since ${d(x.created)}, last used ${d(x.last_used)}</span>
<form method="post" action="/settings/devices/${x.id}/revoke" class="inline"><button class="link danger">Sign out</button></form></li>`).join('') || '<li class="muted">None.</li>'}</ul>
<h2>Change password</h2><form method="post" action="/settings/password" class="card form"><label>Current password<input type="password" name="current" required></label>
<label>New password<input type="password" name="password" minlength="8" required></label><button>Change</button></form>`, u));
});
web.post('/settings/devices/:id/revoke', (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  run('UPDATE devices SET revoked=1 WHERE id=? AND user_id=?', Number(c.req.param('id')), u.id);
  return c.redirect('/settings?msg=Device+signed+out');
});
web.post('/settings/password', async (c) => {
  const u = currentUser(c);
  if (!u) return needLogin(c);
  const f = await c.req.parseBody();
  const row = get('SELECT pass FROM users WHERE id=?', u.id);
  if (!checkPassword(String(f.current || ''), row.pass)) return c.redirect('/settings?msg=Wrong+current+password');
  if (String(f.password || '').length < 8) return c.redirect('/settings?msg=New+password+too+short');
  run('UPDATE users SET pass=? WHERE id=?', hashPassword(String(f.password)), u.id);
  return c.redirect('/settings?msg=Password+changed');
});

// ---------- JSON API for the chat page ----------
const japi = new Hono();

japi.use('*', async (c, next) => {
  const u = currentUser(c);
  if (!u) return c.json({ error: 'Not signed in' }, 401);
  c.set('user', u);
  await next();
});
const bad = (c, error, status = 400) => c.json({ error }, status);
function projectFor(c, pid) {
  const u = c.get('user');
  const m = get('SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=? AND m.user_id=?', Number(pid), u.id);
  return m || null;
}
function topicFor(c, tid) {
  const t = topicRow(Number(tid));
  if (!t) return null;
  const p = projectFor(c, t.project_id);
  return p ? { t, p } : null;
}

japi.get('/p/:pid/state', (c) => {
  const u = c.get('user');
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const groups = all('SELECT * FROM groups_ WHERE project_id=? ORDER BY name', p.id).map((g) => ({
    id: g.id, name: g.name,
    topics: all('SELECT * FROM topics WHERE group_id=? ORDER BY name', g.id).map((t) => {
      const un = unread('u', u.id, t.id);
      return { id: t.id, name: t.name, unread: un.n, mentions: un.m, last_seq: t.last_seq, summary: t.summary };
    }),
  }));
  const agents = all(`SELECT a.*, u.username AS owner FROM agents a JOIN users u ON u.id=a.user_id WHERE a.project_id=? AND a.active=1 ORDER BY u.username, a.name`, p.id).map((a) => ({
    id: a.id, owner: a.owner, name: a.name, task: a.task, platform: a.platform, state: agentState(a), approval: agentState(a) !== 'offline' ? a.approval : null,
    topics: all('SELECT topic_id FROM agent_topics WHERE agent_id=?', a.id).map((r) => r.topic_id), version: a.version,
  }));
  return c.json({
    project: { id: p.id, name: p.name, round_s: Math.round(p.round_ms / 1000), role: p.role },
    me: { id: u.id, username: u.username },
    groups,
    people: all('SELECT u.username, m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.username', p.id),
    agents,
    skills: all('SELECT name, description FROM skills WHERE project_id=? ORDER BY name', p.id),
    memory: all('SELECT name, description, corrects, created FROM memory WHERE project_id=? ORDER BY created DESC', p.id),
    notifications: all('SELECT * FROM notifications WHERE user_id=? AND seen=0 AND (project_id=? OR project_id IS NULL) ORDER BY id DESC LIMIT 50', u.id, p.id),
  });
});

const webMessage = (m) => ({
  seq: m.seq, kind: m.kind, created: m.created, reply_to: m.reply_to,
  author: m.agent_id ? `${m.owner}/${m.agent_name}` : m.author, agent: !!m.agent_id,
  html: renderMarkdown(m.body), body: m.body, to: JSON.parse(m.to_ || '[]'), meta: m.meta ? JSON.parse(m.meta) : null,
  file: m.file_id ? { id: m.file_id, name: m.file_name, size: m.file_size } : null,
});

japi.get('/t/:tid/messages', (c) => {
  const x = topicFor(c, c.req.param('tid'));
  if (!x) return bad(c, 'No such topic', 404);
  const u = c.get('user');
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit')) || 60));
  const after = Number(c.req.query('after')) || 0, before = Number(c.req.query('before')) || 0, q = c.req.query('q');
  let rows;
  if (q) rows = all(`${MSG_SELECT} WHERE m.topic_id=? AND m.body LIKE ? ORDER BY m.seq DESC LIMIT ?`, x.t.id, `%${q}%`, limit).reverse();
  else if (after) rows = all(`${MSG_SELECT} WHERE m.topic_id=? AND m.seq>? ORDER BY m.seq ASC LIMIT ?`, x.t.id, after, limit);
  else if (before) rows = all(`${MSG_SELECT} WHERE m.topic_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT ?`, x.t.id, before, limit).reverse();
  else rows = all(`${MSG_SELECT} WHERE m.topic_id=? ORDER BY m.seq DESC LIMIT ?`, x.t.id, limit).reverse();
  const rs = readSeq('u', u.id, x.t.id);
  return c.json({ topic: { id: x.t.id, name: x.t.name, group: x.t.group_name, summary: x.t.summary, summary_html: renderMarkdown(x.t.summary), last_seq: x.t.last_seq }, read_seq: rs.seq, messages: rows.map(webMessage) });
});

japi.post('/t/:tid/messages', async (c) => {
  const x = topicFor(c, c.req.param('tid'));
  if (!x) return bad(c, 'No such topic', 404);
  const b = await c.req.json().catch(() => ({}));
  const body = String(b.body || '').trim();
  if (!body) return bad(c, 'Empty message');
  if (body.length > 20000) return bad(c, 'Message too long');
  const u = c.get('user');
  const { seq } = postMessage(x.t.id, { userId: u.id, agentId: null }, { body, replyTo: Number(b.reply_to) || null });
  markRead('u', u.id, x.t.id, seq);
  return c.json({ seq });
});

japi.post('/t/:tid/read', async (c) => {
  const x = topicFor(c, c.req.param('tid'));
  if (!x) return bad(c, 'No such topic', 404);
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  markRead('u', u.id, x.t.id, Math.min(Number(b.seq) || 0, x.t.last_seq));
  run('UPDATE notifications SET seen=1 WHERE user_id=? AND topic_id=? AND seq<=?', u.id, x.t.id, Number(b.seq) || 0);
  return c.json({ ok: true });
});

japi.post('/t/:tid/summary', async (c) => {
  const x = topicFor(c, c.req.param('tid'));
  if (!x) return bad(c, 'No such topic', 404);
  const b = await c.req.json().catch(() => ({}));
  run('UPDATE topics SET summary=?, summary_at=? WHERE id=?', String(b.summary || '').slice(0, 8000), now(), x.t.id);
  emitProject(x.t.project_id, { type: 'topics' });
  return c.json({ ok: true });
});

japi.post('/t/:tid/upload', async (c) => {
  const x = topicFor(c, c.req.param('tid'));
  if (!x) return bad(c, 'No such topic', 404);
  const f = await c.req.parseBody();
  if (!f.file || typeof f.file === 'string') return bad(c, 'No file');
  if (f.file.size > Number(process.env.MAX_UPLOAD_MB || 50) * 1048576) return bad(c, 'File too large', 413);
  const u = c.get('user');
  const { id, seq } = await saveUpload(x.t, f.file, { userId: u.id, agentId: null }, String(f.text || ''));
  markRead('u', u.id, x.t.id, seq);
  return c.json({ id, seq });
});

japi.delete('/t/:tid', (c) => {
  const x = topicFor(c, c.req.param('tid'));
  if (!x) return bad(c, 'No such topic', 404);
  if (x.p.role !== 'owner') return bad(c, 'Only the project owner can delete topics', 403);
  run('DELETE FROM topics WHERE id=?', x.t.id);
  emitProject(x.p.id, { type: 'topics' });
  return c.json({ ok: true });
});

const NAME_OK = (s) => /^[^/\n]{1,60}$/.test(s) && s.trim() === s;
japi.post('/p/:pid/groups', async (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || '').trim(), topic = String(b.topic || '').trim();
  if (!NAME_OK(name) || (topic && !NAME_OK(topic))) return bad(c, 'Names: up to 60 characters, no /');
  if (get('SELECT 1 FROM groups_ WHERE project_id=? AND name=?', p.id, name)) return bad(c, 'That group exists');
  const gid = Number(run('INSERT INTO groups_(project_id, name) VALUES(?,?)', p.id, name).lastInsertRowid);
  const tid = topic ? Number(run('INSERT INTO topics(group_id, project_id, name) VALUES(?,?,?)', gid, p.id, topic).lastInsertRowid) : null;
  emitProject(p.id, { type: 'topics' });
  return c.json({ id: gid, topic: tid });
});
japi.post('/g/:gid/topics', async (c) => {
  const g = get('SELECT * FROM groups_ WHERE id=?', Number(c.req.param('gid')));
  const p = g && projectFor(c, g.project_id);
  if (!p) return bad(c, 'No such group', 404);
  const name = String((await c.req.json().catch(() => ({}))).name || '').trim();
  if (!NAME_OK(name)) return bad(c, 'Names: up to 60 characters, no /');
  if (get('SELECT 1 FROM topics WHERE group_id=? AND name=?', g.id, name)) return bad(c, 'That topic exists');
  const id = Number(run('INSERT INTO topics(group_id, project_id, name) VALUES(?,?,?)', g.id, p.id, name).lastInsertRowid);
  emitProject(p.id, { type: 'topics' });
  return c.json({ id });
});
japi.delete('/g/:gid', (c) => {
  const g = get('SELECT * FROM groups_ WHERE id=?', Number(c.req.param('gid')));
  const p = g && projectFor(c, g.project_id);
  if (!p) return bad(c, 'No such group', 404);
  if (p.role !== 'owner') return bad(c, 'Only the project owner can delete groups', 403);
  run('DELETE FROM groups_ WHERE id=?', g.id);
  emitProject(p.id, { type: 'topics' });
  return c.json({ ok: true });
});

japi.post('/p/:pid/members', async (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  if (p.role !== 'owner') return bad(c, 'Only the project owner can add people', 403);
  const name = String((await c.req.json().catch(() => ({}))).username || '').trim().replace(/^@/, '');
  const u = get('SELECT id, username FROM users WHERE username=?', name);
  if (!u) return bad(c, `No account named ${name}. They need to sign up first.`, 404);
  run("INSERT OR IGNORE INTO project_members VALUES(?,?,'member')", p.id, u.id);
  emitProject(p.id, { type: 'members' });
  return c.json({ ok: true });
});
japi.delete('/p/:pid/members/:username', (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const me = c.get('user');
  const u = get('SELECT id FROM users WHERE username=?', c.req.param('username'));
  if (!u) return bad(c, 'No such person', 404);
  if (p.role !== 'owner' && u.id !== me.id) return bad(c, 'Only the project owner can remove people', 403);
  if (u.id === get('SELECT owner_id FROM projects WHERE id=?', p.id).owner_id) return bad(c, 'The owner cannot leave their project');
  run('DELETE FROM project_members WHERE project_id=? AND user_id=?', p.id, u.id);
  for (const a of all('SELECT id FROM agents WHERE project_id=? AND user_id=? AND active=1', p.id, u.id)) { run('UPDATE agents SET active=0, session=NULL WHERE id=?', a.id); forgetAgent(a.id); }
  emitProject(p.id, { type: 'members' });
  return c.json({ ok: true });
});
japi.post('/p/:pid/settings', async (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  if (p.role !== 'owner') return bad(c, 'Only the project owner can change settings', 403);
  const b = await c.req.json().catch(() => ({}));
  const s = Math.max(20, Math.min(1800, Number(b.round_s) || 120));
  run('UPDATE projects SET round_ms=? WHERE id=?', s * 1000, p.id);
  return c.json({ ok: true, round_s: s });
});
japi.post('/agents/:id/remove', (c) => {
  const a = get('SELECT * FROM agents WHERE id=?', Number(c.req.param('id')));
  const p = a && projectFor(c, a.project_id);
  if (!p) return bad(c, 'No such agent', 404);
  if (p.role !== 'owner' && a.user_id !== c.get('user').id) return bad(c, 'Only its owner or the project owner can remove an agent', 403);
  run('UPDATE agents SET active=0, session=NULL WHERE id=?', a.id);
  forgetAgent(a.id);
  emitProject(p.id, { type: 'agents' });
  return c.json({ ok: true });
});

// Skills and memory.
japi.get('/p/:pid/skills/:name', (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const s = get('SELECT * FROM skills WHERE project_id=? AND name=?', p.id, c.req.param('name'));
  if (!s) return bad(c, 'No such skill', 404);
  return c.json({ ...s, files: all('SELECT path, content FROM skill_files WHERE skill_id=? ORDER BY path', s.id) });
});
japi.post('/p/:pid/skills', async (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return bad(c, 'Skill name: lowercase words joined by -');
  const description = String(b.description || '').trim().slice(0, 300), body = String(b.body || '');
  if (!description || !body.trim()) return bad(c, 'A skill needs a description and instructions');
  const old = get('SELECT id FROM skills WHERE project_id=? AND name=?', p.id, b.original || name);
  let id;
  if (old) { run('UPDATE skills SET name=?, description=?, body=?, updated=? WHERE id=?', name, description, body, now(), old.id); id = old.id; }
  else id = Number(run('INSERT INTO skills(project_id, name, description, body, updated) VALUES(?,?,?,?,?)', p.id, name, description, body, now()).lastInsertRowid);
  run('DELETE FROM skill_files WHERE skill_id=?', id);
  for (const f of Array.isArray(b.files) ? b.files : []) if (f?.path && String(f.path).trim()) run('INSERT OR REPLACE INTO skill_files VALUES(?,?,?)', id, String(f.path).trim(), String(f.content || ''));
  emitProject(p.id, { type: 'skills' });
  return c.json({ ok: true });
});
japi.delete('/p/:pid/skills/:name', (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  run('DELETE FROM skills WHERE project_id=? AND name=?', p.id, c.req.param('name'));
  emitProject(p.id, { type: 'skills' });
  return c.json({ ok: true });
});
japi.get('/p/:pid/memory/:name', (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const m = get(`SELECT m.*, u.username AS owner, a.name AS agent_name FROM memory m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agents a ON a.id=m.agent_id WHERE m.project_id=? AND m.name=?`, p.id, c.req.param('name'));
  if (!m) return bad(c, 'No such entry', 404);
  return c.json({ ...m, html: renderMarkdown(m.body), topic: topicRow(m.topic_id)?.name });
});
japi.delete('/p/:pid/memory/:name', (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  if (p.role !== 'owner') return bad(c, 'Only the project owner can delete memory', 403);
  run('DELETE FROM memory WHERE project_id=? AND name=?', p.id, c.req.param('name'));
  emitProject(p.id, { type: 'memory' });
  return c.json({ ok: true });
});

japi.post('/notifications/seen', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  if (b.all) run('UPDATE notifications SET seen=1 WHERE user_id=?', u.id);
  else run('UPDATE notifications SET seen=1 WHERE user_id=? AND id=?', u.id, Number(b.id) || 0);
  return c.json({ ok: true });
});

// Live updates for one project page: project events and this person's notifications.
japi.get('/p/:pid/stream', (c) => {
  const p = projectFor(c, c.req.param('pid'));
  if (!p) return bad(c, 'No such project', 404);
  const u = c.get('user');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (s) => {
    let closed = false;
    const send = (ev) => { if (!closed) s.writeSSE({ data: JSON.stringify(ev) }).catch(() => { closed = true; }); };
    bus.on(`project:${p.id}`, send);
    bus.on(`user:${u.id}`, send);
    s.onAbort(() => { closed = true; });
    try {
      while (!closed) { await s.sleep(20000); if (!closed) await s.writeSSE({ event: 'ping', data: '' }).catch(() => { closed = true; }); }
    } finally {
      bus.off(`project:${p.id}`, send);
      bus.off(`user:${u.id}`, send);
    }
  });
});

// Mounted last: Hono copies a sub-app's routes when it is mounted.
web.route('/web/api', japi);

export { currentUser };
