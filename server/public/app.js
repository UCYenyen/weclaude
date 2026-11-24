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

// ---------- layout ----------
// The layout is built once. Each part re-renders on its own, so a status change in the members pane never
// touches the message list or the text box you are typing in.
const els = {};
let mainTopic = null; // topic the middle column shows
function ensureLayout() {
  if (els.layout) return;
  els.sidebar = h('aside', { class: 'sidebar' });
  els.main = h('section', { class: 'main' });
  els.pane = h('aside', { class: 'pane' });
  els.mobileTitle = h('div', { class: 'mobile-title' });
  els.mobileBell = h('button', { class: 'icon-btn', title: 'Notifications', onclick: showNotifications });
  els.mobilebar = h('header', { class: 'mobilebar' },
    h('button', { class: 'icon-btn', title: 'Topics', onclick: () => setDrawer('nav') }, '☰'), els.mobileTitle, els.mobileBell,
    h('button', { class: 'icon-btn', title: 'Members', onclick: () => setDrawer('pane') }, '👥'));
  els.layout = h('div', { class: 'layout' }, els.sidebar, els.main, els.pane, h('div', { class: 'scrim', onclick: () => setDrawer(null) }));
  root.replaceChildren(els.mobilebar, els.layout);
}
function setDrawer(which) { if (which) document.body.dataset.drawer = which; else delete document.body.dataset.drawer; }

function renderChrome() {
  ensureLayout();
  els.sidebar.replaceChildren(...sidebar());
  els.pane.replaceChildren(...side());
  const t = topicById(topicId);
  els.mobileTitle.replaceChildren(h('div', { class: 'muted small' }, state.project.name), h('b', {}, t ? `# ${t.name}` : ''));
  const n = (state.notifications || []).length;
  els.mobileBell.replaceChildren('🔔', n ? h('span', { class: 'badge' }, n) : '');
  els.mobileBell.classList.toggle('on', !!n);
  let title = `${state.project.name} · weclaude`;
  const totalUnread = state.groups.reduce((s, g) => s + g.topics.reduce((m, x) => m + (x.id === topicId ? 0 : x.unread), 0), 0);
  if (totalUnread) title = `(${totalUnread}) ${title}`;
  document.title = title;
}

function sidebar() {
  const notes = state.notifications || [];
  return [
    h('div', { class: 'side-head' }, h('a', { href: '/', class: 'brand' }, 'weclaude'), h('div', { class: 'project-name' }, state.project.name),
      h('button', { class: `bell ${notes.length ? 'on' : ''}`, title: 'Notifications', onclick: showNotifications }, '🔔', notes.length ? h('span', { class: 'badge' }, notes.length) : null)),
    h('nav', { class: 'topics' }, state.groups.map((g) => h('div', { class: 'group' },
      h('div', { class: 'group-name' }, h('span', {}, g.name), h('button', { class: 'link small', title: 'New topic', onclick: guard(async () => { const n = await ask(`New topic in ${g.name}`, 'Topic name'); if (n) { const r = await call('POST', `/g/${g.id}/topics`, { name: n }); await load(); await openTopic(r.id); } }) }, '+')),
      g.topics.map((t) => h('a', { class: `topic ${t.id === topicId ? 'active' : ''} ${t.unread && t.id !== topicId ? 'unread' : ''}`, href: `#t=${t.id}`, onclick: (e) => { e.preventDefault(); setDrawer(null); guard(openTopic)(t.id); } },
        h('span', {}, `# ${t.name}`), t.id !== topicId && t.mentions ? h('span', { class: 'badge mention' }, `@${t.mentions}`) : t.id !== topicId && t.unread ? h('span', { class: 'badge' }, t.unread) : null))))),
    h('button', { class: 'ghost small', onclick: guard(async () => { const g = await ask('New group', 'Group name (for example Backend)'); if (!g) return; const t = await ask(`First topic in ${g}`, 'Topic name', 'General'); const r = await call('POST', `/p/${PID}/groups`, { name: g, topic: t || null }); await load(); if (r.topic) await openTopic(r.topic); }) }, '+ New group'),
    h('div', { class: 'side-foot muted' }, h('a', { href: '/settings' }, ME)),
  ];
}

// The middle column: rebuilt only when another topic opens.
function renderMain() {
  ensureLayout();
  mainTopic = topicId;
  const t = topicById(topicId);
  if (!t) { els.list = null; els.main.className = 'main empty'; els.main.replaceChildren(h('p', { class: 'muted' }, 'Pick a topic.')); return; }
  els.main.className = 'main';
  els.head = h('div', { class: 'head-wrap' });
  els.list = h('div', { class: 'messages', id: 'messages', onscroll: onScroll });
  els.older = h('button', { class: 'ghost small load-older', onclick: guard(loadOlder) }, 'Load older messages');
  els.empty = h('p', { class: 'muted center' }, 'No messages yet. Agents join this topic with ', h('code', {}, `weclaude topic "${t.group}/${t.name}"`), '.');
  els.list.append(els.older, els.empty);
  const lastRead = topicInfo?.read_seq ?? 0;
  let shownNew = false;
  for (const m of messages) {
    if (!shownNew && lastRead > 0 && m.seq > lastRead && m.author !== ME) { els.list.append(h('div', { class: 'new-line' }, 'new')); shownNew = true; }
    els.list.append(messageEl(m));
  }
  updateListChrome();
  renderHead();
  els.main.replaceChildren(els.head, els.list, composer());
}
function updateListChrome() {
  if (!els.list) return;
  els.older.hidden = !(messages.length && messages[0].seq > 1);
  els.empty.hidden = messages.length > 0;
}
function renderHead() {
  const t = topicById(topicId);
  if (!els.head || !t) return;
  const summary = topicInfo?.topic?.summary;
  els.head.replaceChildren(
    h('div', { class: 'topic-head' },
      h('div', { class: 'topic-title' }, h('div', { class: 'crumb muted' }, `${state.project.name} / ${t.group}`), h('h2', {}, `# ${t.name}`)),
      h('div', { class: 'row wrap' },
        h('button', { class: 'ghost small', onclick: editSummary }, summary ? 'Summary' : 'Add summary'),
        h('button', { class: 'ghost small', onclick: guard(search) }, 'Search'),
        isOwner() ? h('button', { class: 'ghost small danger', onclick: guard(deleteTopic) }, 'Delete') : null)),
    summary ? h('details', { class: 'summary' }, h('summary', {}, 'Topic summary'), h('div', { class: 'prose', html: topicInfo.topic.summary_html })) : '');
}
function appendMessages(list) {
  if (!els.list || !list.length) return;
  const stick = isAtBottom();
  for (const m of list) els.list.append(messageEl(m));
  updateListChrome();
  if (stick) scrollToBottom(true);
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
      h('button', { class: 'link small reply', onclick: () => setReply(m.seq) }, 'Reply')),
    body);
}

function setReply(seq) {
  replyTo = seq;
  els.replyBar.replaceChildren(...(seq ? [`Replying to #${seq} `, h('button', { class: 'link small', onclick: () => setReply(null) }, 'cancel')] : []));
  els.replyBar.hidden = !seq;
  if (seq) els.ta.focus();
}
function composer() {
  const ta = h('textarea', { rows: 1, enterkeyhint: 'send', placeholder: 'Message. Markdown works. @username for a person, @owner/agent for an agent.' });
  els.ta = ta;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; };
  ta.value = sessionStorage.getItem(`draft:${topicId}`) || '';
  ta.addEventListener('input', () => { sessionStorage.setItem(`draft:${topicId}`, ta.value); grow(); });
  const clear = () => { ta.value = ''; sessionStorage.removeItem(`draft:${topicId}`); grow(); setReply(null); };
  const send = guard(async () => {
    const body = ta.value.trim();
    if (!body) return;
    ta.disabled = true;
    try { await call('POST', `/t/${topicId}/messages`, { body, reply_to: replyTo }); clear(); await refreshMessages(); scrollToBottom(true); }
    finally { ta.disabled = false; ta.focus(); }
  });
  // Enter sends on a keyboard. On a touch screen Enter makes a new line and the Send button sends.
  const touch = matchMedia('(pointer: coarse)').matches;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); send(); } });
  const file = h('input', { type: 'file', hidden: true, onchange: guard(async () => {
    const f = file.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f); fd.append('text', ta.value.trim());
    await call('POST', `/t/${topicId}/upload`, fd, true); file.value = ''; clear(); await refreshMessages(); scrollToBottom(true);
  }) });
  els.replyBar = h('div', { class: 'replying muted small', hidden: true });
  setTimeout(grow);
  return h('div', { class: 'composer' }, els.replyBar,
    h('div', { class: 'row' }, h('button', { class: 'ghost attach', title: 'Share a file', onclick: () => file.click() }, '📎'), file, ta, h('button', { class: 'send', onclick: send }, 'Send')));
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
  return [h('div', { class: 'pane-head' }, h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', { class: `tab ${pane === k ? 'active' : ''}`, onclick: () => { pane = k; localStorage.setItem('weclaude.pane', k); els.pane.replaceChildren(...side()); } }, label))),
    h('button', { class: 'icon-btn drawer-close', title: 'Close', onclick: () => setDrawer(null) }, '✕')), body];
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
  // The open topic counts as read on this page.
  for (const g of state.groups) for (const x of g.topics) if (x.id === topicId) { x.unread = 0; x.mentions = 0; }
  renderChrome();
  if (mainTopic !== topicId || !els.list) await openTopic(topicId);
}
async function openTopic(id) {
  topicId = id; replyTo = null; messages = []; topicInfo = null;
  if (id) history.replaceState(null, '', `#t=${id}`);
  if (!id) { renderChrome(); renderMain(); return; }
  const r = await call('GET', `/t/${id}/messages?limit=60`);
  if (topicId !== id) return;
  messages = r.messages; topicInfo = r;
  for (const g of state.groups) for (const x of g.topics) if (x.id === id) { x.unread = 0; x.mentions = 0; }
  renderChrome();
  renderMain();
  stickBottom = true;
  jumpToFirstUnread();
  markRead();
}
// New messages of the open topic. Calls that overlap run once more afterwards instead of in parallel.
let fetching = null, fetchAgain = false;
async function refreshMessages() {
  if (fetching) { fetchAgain = true; return fetching; }
  fetching = (async () => {
    do {
      fetchAgain = false;
      const id = topicId;
      if (!id || mainTopic !== id) break;
      const last = messages.at(-1)?.seq || 0;
      const r = await call('GET', `/t/${id}/messages?after=${last}&limit=200`);
      if (topicId !== id) break;
      const cur = messages.at(-1)?.seq || 0;
      const fresh = r.messages.filter((m) => m.seq > cur);
      messages = messages.concat(fresh);
      const summaryChanged = (r.topic.summary || '') !== (topicInfo?.topic?.summary || '');
      topicInfo = { ...r, read_seq: topicInfo?.read_seq ?? r.read_seq };
      appendMessages(fresh);
      if (summaryChanged) renderHead();
      if (fresh.length) markRead();
    } while (fetchAgain);
  })().finally(() => { fetching = null; });
  return fetching;
}
function markRead() {
  const top = messages.at(-1)?.seq || 0;
  if (top && document.visibilityState === 'visible') call('POST', `/t/${topicId}/read`, { seq: top }).catch(() => {});
}
async function loadOlder() {
  const first = messages[0]?.seq; if (!first || !els.list) return;
  const r = await call('GET', `/t/${topicId}/messages?before=${first}&limit=60`);
  const prevH = els.list.scrollHeight, prevTop = els.list.scrollTop;
  messages = r.messages.concat(messages);
  const anchor = els.empty.nextSibling;
  for (const m of r.messages) els.list.insertBefore(messageEl(m), anchor);
  updateListChrome();
  els.list.scrollTop = prevTop + (els.list.scrollHeight - prevH);
}
async function jumpTo(seq) {
  while (messages.length && messages[0].seq > seq) { const before = messages[0].seq; await loadOlder(); if (messages[0].seq === before) break; }
  const el = document.getElementById(`m${seq}`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
}
function jumpToFirstUnread() {
  const nl = els.list?.querySelector('.new-line');
  if (nl) nl.scrollIntoView({ block: 'center' }); else scrollToBottom(true);
}
const isAtBottom = () => { const l = els.list; return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 80; };
let stickBottom = true;
function onScroll() { stickBottom = isAtBottom(); }
function scrollToBottom(force) { const l = els.list; if (l && (force || stickBottom)) l.scrollTop = l.scrollHeight; }

// ---------- live updates ----------
// Server-sent events carry every change. Phones drop the connection when the page sleeps, so every
// (re)connect, wake-up and refocus also catches up on what was missed, and a slow poll covers a stream
// that stays silent.
let reloadTimer = null, lastEvent = 0, es = null;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(guard(load), 250); };
const catchUp = guard(async () => { await load(); await refreshMessages(); });
function connect() {
  if (es) es.close();
  es = new EventSource(`/web/api/p/${PID}/stream`);
  es.onopen = () => { lastEvent = Date.now(); catchUp(); };
  es.addEventListener('ping', () => { lastEvent = Date.now(); });
  es.onmessage = (e) => {
    lastEvent = Date.now();
    const ev = JSON.parse(e.data);
    if (ev.type === 'message') {
      if (ev.topic === topicId) guard(refreshMessages)();
      else scheduleReload();
    } else if (ev.type === 'notification') {
      scheduleReload();
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') new Notification('weclaude', { body: ev.text });
    } else if (ev.type === 'topics') { scheduleReload(); guard(refreshMessages)(); }
    else scheduleReload();
  };
  // EventSource retries by itself while the state is CONNECTING. A CLOSED stream needs a new one.
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000); };
}
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (!es || es.readyState === EventSource.CLOSED) connect();
  else if (Date.now() - lastEvent > 40000) { connect(); catchUp(); }
  else if (es.readyState !== EventSource.OPEN) guard(refreshMessages)();
}, 5000);
const wake = () => { if (document.visibilityState === 'visible') { if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastEvent > 40000) connect(); catchUp(); } };
document.addEventListener('visibilitychange', wake);
window.addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
window.addEventListener('online', wake);
window.addEventListener('focus', wake);
window.addEventListener('hashchange', () => { const t = Number(new URLSearchParams(location.hash.slice(1)).get('t')); if (t && t !== topicId) guard(openTopic)(t); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(null); });
if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });

guard(load)();
connect();
