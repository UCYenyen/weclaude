// weclaude chat page: topics on the left, messages in the middle, members, skills and memory on the right.
const PID = document.body.dataset.project;
const ME = document.body.dataset.me;
const root = document.getElementById('root');

let state = null;           // /state payload
let topicId = Number(new URLSearchParams(location.hash.slice(1)).get('t')) || null;
let messages = [];          // loaded messages of the open topic
let topicInfo = null;
let replyTo = null;
let pane = localStorage.getItem('weclaude.pane') || 'members';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
async function call(method, url, body, isForm) {
  const res = await fetch(`/web/api${url}`, { method, headers: body && !isForm ? { 'content-type': 'application/json' } : {}, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const fmtTime = (ms) => { const d = new Date(ms); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const topicById = (id) => { for (const g of state.groups) for (const t of g.topics) if (t.id === id) return { ...t, group: g.name }; return null; };
const isOwner = () => state.project.role === 'owner';
function toast(msg) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 4000); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'signed out') toast(e.message); } };

function modal(title, body, actions = []) {
  const close = () => back.remove();
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, h('b', {}, title), h('button', { class: 'link', onclick: close }, '✕')), body,
      actions.length ? h('div', { class: 'row end' }, ...actions.map(([label, fn, cls]) => h('button', { class: cls || '', onclick: guard(async () => { if ((await fn()) !== false) close(); }) }, label))) : null));
  document.body.append(back);
  back.querySelector('input,textarea')?.focus();
  return close;
}
const ask = (title, label, value = '') => new Promise((resolve) => {
  const input = h('input', { value });
  const close = modal(title, h('label', {}, label, input), [['Cancel', () => resolve(null), 'ghost'], ['OK', () => resolve(input.value.trim())]]);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { resolve(input.value.trim()); close(); } });
});

// ---------- rendering ----------
function render() {
  if (!state) return;
  document.title = `${state.project.name} · weclaude`;
  const totalUnread = state.groups.reduce((n, g) => n + g.topics.reduce((m, t) => m + (t.id === topicId ? 0 : t.unread), 0), 0);
  if (totalUnread) document.title = `(${totalUnread}) ${document.title}`;
  root.replaceChildren(h('div', { class: 'layout' }, sidebar(), main(), side()));
  scrollToBottom(false);
}

function sidebar() {
  const notes = state.notifications || [];
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'side-head' }, h('a', { href: '/', class: 'brand' }, 'weclaude'), h('div', { class: 'project-name' }, state.project.name),
      h('button', { class: `bell ${notes.length ? 'on' : ''}`, title: 'Notifications', onclick: showNotifications }, '🔔', notes.length ? h('span', { class: 'badge' }, notes.length) : null)),
    h('nav', { class: 'topics' }, state.groups.map((g) => h('div', { class: 'group' },
      h('div', { class: 'group-name' }, h('span', {}, g.name), h('button', { class: 'link small', title: 'New topic', onclick: guard(async () => { const n = await ask(`New topic in ${g.name}`, 'Topic name'); if (n) { const r = await call('POST', `/g/${g.id}/topics`, { name: n }); await load(); openTopic(r.id); } }) }, '+')),
      g.topics.map((t) => h('a', { class: `topic ${t.id === topicId ? 'active' : ''} ${t.unread && t.id !== topicId ? 'unread' : ''}`, href: `#t=${t.id}`, onclick: (e) => { e.preventDefault(); openTopic(t.id); } },
        h('span', {}, `# ${t.name}`), t.id !== topicId && t.mentions ? h('span', { class: 'badge mention' }, `@${t.mentions}`) : t.id !== topicId && t.unread ? h('span', { class: 'badge' }, t.unread) : null))))),
    h('button', { class: 'ghost small', onclick: guard(async () => { const g = await ask('New group', 'Group name (for example Backend)'); if (!g) return; const t = await ask(`First topic in ${g}`, 'Topic name', 'General'); const r = await call('POST', `/p/${PID}/groups`, { name: g, topic: t || null }); await load(); if (r.topic) openTopic(r.topic); }) }, '+ New group'),
    h('div', { class: 'side-foot muted' }, h('a', { href: '/settings' }, ME)));
}

function main() {
  if (!topicId || !topicById(topicId)) return h('section', { class: 'main empty' }, h('p', { class: 'muted' }, 'Pick a topic.'));
  const t = topicById(topicId);
  const list = h('div', { class: 'messages', id: 'messages', onscroll: onScroll });
  if (messages.length && messages[0].seq > 1) list.append(h('button', { class: 'ghost small load-older', onclick: guard(loadOlder) }, 'Load older messages'));
  let lastRead = topicInfo?.read_seq ?? 0, shownNew = false;
  for (const m of messages) {
    if (!shownNew && m.seq > lastRead && lastRead > 0 && m.author !== ME) { list.append(h('div', { class: 'new-line' }, 'new')); shownNew = true; }
    list.append(messageEl(m));
  }
  if (!messages.length) list.append(h('p', { class: 'muted center' }, 'No messages yet. Agents join this topic with ', h('code', {}, `weclaude topic "${t.group}/${t.name}"`), '.'));
  const summary = topicInfo?.topic?.summary;
  return h('section', { class: 'main' },
    h('div', { class: 'topic-head' },
      h('div', {}, h('div', { class: 'crumb muted' }, `${state.project.name} / ${t.group}`), h('h2', {}, `# ${t.name}`)),
      h('div', { class: 'row' },
        h('button', { class: 'ghost small', onclick: editSummary }, summary ? 'Summary' : 'Add summary'),
        h('button', { class: 'ghost small', onclick: guard(search) }, 'Search'),
        isOwner() ? h('button', { class: 'ghost small danger', onclick: guard(deleteTopic) }, 'Delete') : null)),
    summary ? h('details', { class: 'summary' }, h('summary', {}, 'Topic summary'), h('div', { class: 'prose', html: topicInfo.topic.summary_html })) : null,
    list, composer());
}

function messageEl(m) {
  const cls = ['msg', m.agent ? 'agent' : 'person', m.author === ME ? 'mine' : '', m.kind].join(' ');
  let body;
  if (m.kind === 'decision' || m.kind === 'request') {
    body = h('div', { class: `card-${m.kind}` }, h('div', { class: 'card-kind' }, m.kind === 'decision' ? 'Decision' : 'Request'), h('div', { class: 'prose', html: m.html }),
      m.to?.length ? h('div', { class: 'muted small' }, `To: ${m.to.join(', ')}`) : null,
      m.meta?.seqs?.length ? h('div', { class: 'muted small' }, 'From ', ...m.meta.seqs.map((s) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); jumpTo(s); } }, `#${s} `))) : null);
  } else if (m.kind === 'system') body = h('div', { class: 'muted small' }, m.body);
  else body = h('div', {}, m.file ? h('div', { class: 'file' }, '📎 ', h('a', { href: `/api/files/${m.file.id}` }, m.file.name), h('span', { class: 'muted small' }, ` ${fmtSize(m.file.size || 0)} · f${m.file.id}`)) : null, m.body ? h('div', { class: 'prose', html: m.html }) : null);
  return h('div', { class: cls, id: `m${m.seq}` },
    h('div', { class: 'msg-head' }, h('span', { class: `who ${m.agent ? 'agent' : ''}` }, m.agent ? '🤖 ' : '', m.author),
      m.reply_to ? h('a', { class: 'muted small', href: '#', onclick: (e) => { e.preventDefault(); jumpTo(m.reply_to); } }, `↳ #${m.reply_to}`) : null,
      h('span', { class: 'muted small' }, `#${m.seq} · ${fmtTime(m.created)}`),
      h('button', { class: 'link small reply', onclick: () => { replyTo = m.seq; render(); document.querySelector('.composer textarea')?.focus(); } }, 'Reply')),
    body);
}

function composer() {
  const ta = h('textarea', { rows: 2, placeholder: `Message — Markdown works. @username for a person, @owner/agent for an agent. Enter to send, Shift+Enter for a new line.` });
  ta.value = sessionStorage.getItem(`draft:${topicId}`) || '';
  ta.addEventListener('input', () => { sessionStorage.setItem(`draft:${topicId}`, ta.value); ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`; });
  const send = guard(async () => {
    const body = ta.value.trim();
    if (!body) return;
    ta.disabled = true;
    try { await call('POST', `/t/${topicId}/messages`, { body, reply_to: replyTo }); ta.value = ''; sessionStorage.removeItem(`draft:${topicId}`); replyTo = null; await refreshMessages(); }
    finally { ta.disabled = false; ta.focus(); }
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  const file = h('input', { type: 'file', hidden: true, onchange: guard(async () => {
    const f = file.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f); fd.append('text', ta.value.trim());
    await call('POST', `/t/${topicId}/upload`, fd, true); ta.value = ''; sessionStorage.removeItem(`draft:${topicId}`); await refreshMessages();
  }) });
  return h('div', { class: 'composer' },
    replyTo ? h('div', { class: 'replying muted small' }, `Replying to #${replyTo} `, h('button', { class: 'link small', onclick: () => { replyTo = null; render(); } }, 'cancel')) : null,
    h('div', { class: 'row' }, h('button', { class: 'ghost', title: 'Share a file', onclick: () => file.click() }, '📎'), file, ta, h('button', { onclick: send }, 'Send')));
}

const stateDot = (s) => h('span', { class: `dot ${s}`, title: s });
function side() {
  const tabs = [['members', 'Members'], ['skills', 'Skills'], ['memory', 'Memory'], ['settings', 'Project']];
  let body;
  if (pane === 'members') {
    const inTopic = (a) => a.topics.includes(topicId);
    body = h('div', {},
      h('h4', {}, 'Agents'), state.agents.length ? state.agents.map((a) => h('div', { class: `member ${inTopic(a) ? '' : 'faded'}` },
        h('div', { class: 'row between' }, h('span', {}, stateDot(a.state), ` ${a.owner}/${a.name}`), (a.owner === ME || isOwner()) ? h('button', { class: 'link small danger', title: 'Remove from project', onclick: guard(async () => { if (confirm(`Remove ${a.owner}/${a.name} from the project?`)) { await call('POST', `/agents/${a.id}/remove`); await load(); } }) }, '✕') : null),
        h('div', { class: 'muted small' }, `${a.state}${a.platform ? ` · ${a.platform.toLowerCase().replace('_', ' ')}` : ''}${inTopic(a) ? '' : ' · not in this topic'}`),
        a.approval ? h('div', { class: 'approval small' }, `Waiting for approval: ${a.approval}`) : null,
        a.task ? h('div', { class: 'task small' }, a.task) : null)) : h('p', { class: 'muted small' }, 'No agents yet. Run /weclaude:join ', state.project.name, ' in Claude Code.'),
      h('h4', {}, 'People'), state.people.map((p) => h('div', { class: 'member row between' }, h('span', {}, `@${p.username}`, p.role === 'owner' ? h('span', { class: 'muted small' }, ' owner') : null),
        isOwner() && p.role !== 'owner' ? h('button', { class: 'link small danger', onclick: guard(async () => { if (confirm(`Remove ${p.username} from the project?`)) { await call('DELETE', `/p/${PID}/members/${encodeURIComponent(p.username)}`); await load(); } }) }, '✕') : null)),
      isOwner() ? h('button', { class: 'ghost small', onclick: guard(async () => { const u = await ask('Add a person', 'Their weclaude username'); if (u) { await call('POST', `/p/${PID}/members`, { username: u }); await load(); } }) }, '+ Add person') : null);
  } else if (pane === 'skills') {
    body = h('div', {}, h('p', { class: 'muted small' }, 'Instructions every agent in the project reads before work they cover.'),
      state.skills.map((s) => h('div', { class: 'member clickable', onclick: guard(() => editSkill(s.name)) }, h('b', {}, s.name), h('div', { class: 'muted small' }, s.description))),
      h('button', { class: 'ghost small', onclick: guard(() => editSkill(null)) }, '+ New skill'));
  } else if (pane === 'memory') {
    body = h('div', {}, h('p', { class: 'muted small' }, 'Entries agents wrote: decisions, sources, traps and conventions.'),
      state.memory.length ? state.memory.map((m) => h('div', { class: 'member clickable', onclick: guard(() => showMemory(m.name)) }, h('b', {}, m.name), h('div', { class: 'muted small' }, m.description))) : h('p', { class: 'muted small' }, 'None yet.'));
  } else {
    const round = h('input', { type: 'number', min: 20, max: 1800, value: state.project.round_s, disabled: !isOwner() });
    body = h('div', {},
      h('label', { class: 'small' }, 'Round limit (seconds)', round),
      h('p', { class: 'muted small' }, 'How long a round waits for the woken agents before passing on new messages.'),
      isOwner() ? h('button', { class: 'small', onclick: guard(async () => { await call('POST', `/p/${PID}/settings`, { round_s: Number(round.value) }); await load(); toast('Saved'); }) }, 'Save') : null,
      h('h4', {}, 'Connect an agent'),
      h('pre', { class: 'small' }, h('code', {}, `/weclaude:login\n/weclaude:join ${state.project.name}\n/weclaude:topic "General/Chat"`)),
      !isOwner() ? h('button', { class: 'ghost small danger', onclick: guard(async () => { if (confirm('Leave this project?')) { await call('DELETE', `/p/${PID}/members/${encodeURIComponent(ME)}`); location.href = '/'; } }) }, 'Leave project') : null);
  }
  return h('aside', { class: 'pane' }, h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', { class: `tab ${pane === k ? 'active' : ''}`, onclick: () => { pane = k; localStorage.setItem('weclaude.pane', k); render(); } }, label))), body);
}

// ---------- actions ----------
function editSummary() {
  const ta = h('textarea', { rows: 12 }); ta.value = topicInfo?.topic?.summary || '';
  modal('Topic summary', h('div', {}, h('p', { class: 'muted small' }, 'Decisions, links, owners and open questions. Agents see it in status, and once in read_messages after it changes.'), ta),
    [['Cancel', () => {}, 'ghost'], ['Save', async () => { await call('POST', `/t/${topicId}/summary`, { summary: ta.value }); await refreshMessages(); }]]);
}
async function search() {
  const q = await ask('Search this topic', 'Words');
  if (!q) return;
  const r = await call('GET', `/t/${topicId}/messages?q=${encodeURIComponent(q)}&limit=50`);
  modal(`Matches for "${q}"`, h('div', { class: 'search-results' }, r.messages.length ? r.messages.map((m) => h('div', { class: 'clickable', onclick: () => { document.querySelector('.modal-back')?.remove(); jumpTo(m.seq); } }, messageEl(m))) : h('p', { class: 'muted' }, 'No matches.')));
}
async function deleteTopic() {
  const t = topicById(topicId);
  if (!confirm(`Delete topic ${t.group}/${t.name} and all its messages?`)) return;
  await call('DELETE', `/t/${topicId}`);
  topicId = null; await load();
}
async function editSkill(name) {
  const s = name ? await call('GET', `/p/${PID}/skills/${encodeURIComponent(name)}`) : { name: '', description: '', body: '', files: [] };
  const nm = h('input', { value: s.name, placeholder: 'deploy-to-staging' }), desc = h('input', { value: s.description, placeholder: 'When to use it, in one line' });
  const body = h('textarea', { rows: 12, placeholder: 'Steps the agents follow' }); body.value = s.body;
  const files = h('div', {});
  const addFile = (f = { path: '', content: '' }) => { const p = h('input', { value: f.path, placeholder: 'path, e.g. scripts/check.sh' }), c = h('textarea', { rows: 4 }); c.value = f.content; const row = h('div', { class: 'skill-file' }, p, c, h('button', { class: 'link small danger', onclick: () => row.remove() }, 'Remove file')); row._get = () => ({ path: p.value, content: c.value }); files.append(row); };
  s.files.forEach(addFile);
  const actions = [['Cancel', () => {}, 'ghost'], ['Save', async () => { await call('POST', `/p/${PID}/skills`, { original: s.name || null, name: nm.value, description: desc.value, body: body.value, files: [...files.children].map((r) => r._get()) }); await load(); }]];
  if (name) actions.unshift(['Delete', async () => { if (!confirm(`Delete skill ${name}?`)) return false; await call('DELETE', `/p/${PID}/skills/${encodeURIComponent(name)}`); await load(); }, 'ghost danger']);
  modal(name ? `Skill ${name}` : 'New skill', h('div', { class: 'form' }, h('label', {}, 'Name', nm), h('label', {}, 'Description', desc), h('label', {}, 'Instructions (Markdown)', body), h('div', { class: 'muted small' }, 'Files'), files, h('button', { class: 'ghost small', onclick: () => addFile() }, '+ Add file')), actions);
}
async function showMemory(name) {
  const m = await call('GET', `/p/${PID}/memory/${encodeURIComponent(name)}`);
  const actions = isOwner() ? [['Delete', async () => { if (!confirm(`Delete memory entry ${name}?`)) return false; await call('DELETE', `/p/${PID}/memory/${encodeURIComponent(name)}`); await load(); }, 'ghost danger']] : [];
  modal(m.name, h('div', {}, h('p', {}, m.description), h('div', { class: 'prose', html: m.html }),
    h('p', { class: 'muted small' }, `By ${m.agent_name ? `${m.owner}/${m.agent_name}` : m.owner} · ${new Date(m.created).toLocaleString()}${m.topic ? ` · # ${m.topic}` : ''}${m.corrects ? ` · corrects ${m.corrects}` : ''}`)), actions);
}
function showNotifications() {
  const notes = state.notifications || [];
  modal('Notifications', h('div', {}, notes.length ? notes.map((n) => h('div', { class: 'note clickable', onclick: guard(async () => { await call('POST', '/notifications/seen', { id: n.id }); document.querySelector('.modal-back')?.remove(); if (n.topic_id) { await openTopic(n.topic_id); if (n.seq) jumpTo(n.seq); } else await load(); }) }, h('div', {}, n.text), h('div', { class: 'muted small' }, fmtTime(n.created)))) : h('p', { class: 'muted' }, 'Nothing new.')),
    notes.length ? [['Mark all read', async () => { await call('POST', '/notifications/seen', { all: true }); await load(); }, 'ghost']] : []);
}

// ---------- data ----------
async function load() {
  state = await call('GET', `/p/${PID}/state`);
  if (!topicId || !topicById(topicId)) topicId = state.groups.flatMap((g) => g.topics)[0]?.id || null;
  if (topicId && topicInfo?.topic?.id !== topicId) await refreshMessages(true);
  else render();
}
async function openTopic(id) {
  topicId = id; replyTo = null; messages = []; topicInfo = null;
  history.replaceState(null, '', `#t=${id}`);
  await refreshMessages(true);
}
async function refreshMessages(full = false) {
  if (!topicId) return render();
  const last = messages.at(-1)?.seq || 0;
  const r = full || !last ? await call('GET', `/t/${topicId}/messages?limit=60`) : await call('GET', `/t/${topicId}/messages?after=${last}&limit=200`);
  const atBottom = isAtBottom();
  if (full || !last) { messages = r.messages; topicInfo = r; }
  else { const cur = messages.at(-1)?.seq || 0; messages = messages.concat(r.messages.filter((m) => m.seq > cur)); topicInfo = { ...r, read_seq: topicInfo?.read_seq ?? r.read_seq }; }
  const top = messages.at(-1)?.seq || 0;
  const t = topicById(topicId);
  if (t) { t.unread = 0; t.mentions = 0; for (const g of state.groups) for (const x of g.topics) if (x.id === topicId) { x.unread = 0; x.mentions = 0; } }
  render();
  if (full) jumpToFirstUnread(); else if (atBottom) scrollToBottom(true);
  if (top && document.visibilityState === 'visible') call('POST', `/t/${topicId}/read`, { seq: top }).catch(() => {});
}
async function loadOlder() {
  const first = messages[0]?.seq; if (!first) return;
  const r = await call('GET', `/t/${topicId}/messages?before=${first}&limit=60`);
  const list = document.getElementById('messages'); const prevH = list.scrollHeight;
  messages = r.messages.concat(messages); render();
  const l2 = document.getElementById('messages'); l2.scrollTop = l2.scrollHeight - prevH;
}
async function jumpTo(seq) {
  while (messages.length && messages[0].seq > seq) { const before = messages[0].seq; await loadOlder(); if (messages[0].seq === before) break; }
  const el = document.getElementById(`m${seq}`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
}
function jumpToFirstUnread() {
  const nl = document.querySelector('.new-line');
  if (nl) nl.scrollIntoView({ block: 'center' }); else scrollToBottom(false);
}
const isAtBottom = () => { const l = document.getElementById('messages'); return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 80; };
let stickBottom = true;
function onScroll() { stickBottom = isAtBottom(); }
function scrollToBottom(force) { const l = document.getElementById('messages'); if (l && (force || stickBottom)) l.scrollTop = l.scrollHeight; }

// ---------- live updates ----------
let reloadTimer = null;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(guard(load), 300); };
function connect() {
  const es = new EventSource(`/web/api/p/${PID}/stream`);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'message') {
      if (ev.topic === topicId) guard(refreshMessages)();
      else scheduleReload();
    } else if (ev.type === 'notification') {
      scheduleReload();
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') new Notification('weclaude', { body: ev.text });
    } else scheduleReload();
  };
  es.onerror = () => { es.close(); setTimeout(() => { connect(); guard(load)(); }, 3000); };
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && topicId) guard(refreshMessages)(); });
window.addEventListener('hashchange', () => { const t = Number(new URLSearchParams(location.hash.slice(1)).get('t')); if (t && t !== topicId) guard(openTopic)(t); });
if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });

guard(load)();
connect();
