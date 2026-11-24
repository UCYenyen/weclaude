// SQLite storage and small query helpers. One file, one connection, synchronous.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || './data';
mkdirSync(`${DATA_DIR}/files`, { recursive: true });

export const db = new DatabaseSync(`${DATA_DIR}/weclaude.db`);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, pass TEXT NOT NULL, admin INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS web_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER);
CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT, token_hash TEXT UNIQUE, created INTEGER, last_used INTEGER, revoked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS device_logins(code TEXT PRIMARY KEY, poll TEXT UNIQUE, name TEXT, user_id INTEGER, token TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, owner_id INTEGER, round_ms INTEGER DEFAULT 120000, created INTEGER);
CREATE TABLE IF NOT EXISTS project_members(project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, role TEXT DEFAULT 'member', PRIMARY KEY(project_id, user_id));
CREATE TABLE IF NOT EXISTS groups_(id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, name TEXT COLLATE NOCASE, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, group_id INTEGER REFERENCES groups_(id) ON DELETE CASCADE, project_id INTEGER, name TEXT COLLATE NOCASE, summary TEXT DEFAULT '', summary_at INTEGER DEFAULT 0, last_seq INTEGER DEFAULT 0, UNIQUE(group_id, name));
CREATE TABLE IF NOT EXISTS agents(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, session TEXT, name TEXT, platform TEXT, model TEXT, task TEXT DEFAULT '', state TEXT DEFAULT 'idle', state_at INTEGER DEFAULT 0, approval TEXT, active INTEGER DEFAULT 1, session_started INTEGER DEFAULT 0, memory_checked INTEGER DEFAULT 0, version TEXT, created INTEGER, UNIQUE(project_id, user_id, name));
CREATE INDEX IF NOT EXISTS agents_session ON agents(user_id, session);
CREATE TABLE IF NOT EXISTS agent_topics(agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, PRIMARY KEY(agent_id, topic_id));
CREATE TABLE IF NOT EXISTS reads(kind TEXT, who INTEGER, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, seq INTEGER DEFAULT 0, summary_seen INTEGER DEFAULT 0, PRIMARY KEY(kind, who, topic_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, seq INTEGER, user_id INTEGER, agent_id INTEGER, kind TEXT DEFAULT 'message', body TEXT, to_ TEXT, reply_to INTEGER, file_id INTEGER, meta TEXT, created INTEGER, UNIQUE(topic_id, seq));
CREATE TABLE IF NOT EXISTS mentions(topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, seq INTEGER, kind TEXT, who INTEGER, PRIMARY KEY(topic_id, seq, kind, who));
CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, project_id INTEGER, name TEXT, size INTEGER, mime TEXT, user_id INTEGER, agent_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS memory(id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, topic_id INTEGER, name TEXT, description TEXT, body TEXT, sources TEXT, links TEXT, corrects TEXT, user_id INTEGER, agent_id INTEGER, created INTEGER, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, project_id INTEGER, topic_id INTEGER, seqs TEXT, ranked TEXT, idx INTEGER DEFAULT 0, assigned_at INTEGER, objected INTEGER DEFAULT 0, done INTEGER DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS skills(id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, name TEXT, description TEXT, body TEXT, updated INTEGER, UNIQUE(project_id, name));
CREATE TABLE IF NOT EXISTS skill_files(skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE, path TEXT, content TEXT, PRIMARY KEY(skill_id, path));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, project_id INTEGER, topic_id INTEGER, seq INTEGER, text TEXT, created INTEGER, seen INTEGER DEFAULT 0);
`);

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const now = () => Date.now();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hashPassword(pass) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pass, salt, 64).toString('hex')}`;
}
export function checkPassword(pass, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pass, salt, 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Names and paths.
export const topicRow = (id) => get(`SELECT t.*, g.name AS group_name, p.name AS project_name FROM topics t JOIN groups_ g ON g.id=t.group_id JOIN projects p ON p.id=t.project_id WHERE t.id=?`, id);
export const topicPath = (t) => `${t.project_name}/${t.group_name}/${t.name}`;
export const agentLabel = (a) => `${a.owner ?? get('SELECT username FROM users WHERE id=?', a.user_id)?.username}/${a.name}`;
export const username = (id) => get('SELECT username FROM users WHERE id=?', id)?.username;
export const isMember = (projectId, userId) => !!get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', projectId, userId);

// Read state for a human ('u') or an agent ('a').
export function readSeq(kind, who, topicId) {
  return get('SELECT seq, summary_seen FROM reads WHERE kind=? AND who=? AND topic_id=?', kind, who, topicId) || { seq: 0, summary_seen: 0 };
}
export function markRead(kind, who, topicId, seq) {
  run(`INSERT INTO reads(kind, who, topic_id, seq) VALUES(?,?,?,?)
       ON CONFLICT(kind, who, topic_id) DO UPDATE SET seq=MAX(seq, excluded.seq)`, kind, who, topicId, seq);
}
export function markSummarySeen(kind, who, topicId, at) {
  run(`INSERT INTO reads(kind, who, topic_id, summary_seen) VALUES(?,?,?,?)
       ON CONFLICT(kind, who, topic_id) DO UPDATE SET summary_seen=excluded.summary_seen`, kind, who, topicId, at);
}
// Unread messages written by someone else, and how many of them mention the reader.
export function unread(kind, who, topicId) {
  const { seq } = readSeq(kind, who, topicId);
  const own = kind === 'a' ? 'agent_id' : 'user_id';
  const extra = kind === 'u' ? ' AND agent_id IS NULL' : '';
  const n = get(`SELECT COUNT(*) AS n FROM messages WHERE topic_id=? AND seq>? AND NOT (IFNULL(${own},-1)=?${extra})`, topicId, seq, who).n;
  const m = get('SELECT COUNT(*) AS n FROM mentions WHERE topic_id=? AND seq>? AND kind=? AND who=?', topicId, seq, kind, who).n;
  return { n, m, seq };
}
