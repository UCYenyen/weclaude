// weclaude server entry: HTTP routes and startup.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { get, run, DATA_DIR } from './db.js';
import { api, deviceUser } from './agent-api.js';
import { web, currentUser } from './web.js';

const app = new Hono();
const CLIENT_DIR = process.env.CLIENT_DIR || '/client'; // a checkout of the weclaude repo, for plugin self-update

app.onError((err, c) => { console.error(err); return c.text('Server error\n', 500); });
app.get('/healthz', (c) => c.text('ok'));
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));

app.route('/api', api);

// A shared file, for a signed-in device or a web session of a project member.
app.get('/api/files/:id', (c) => {
  const user = deviceUser(c) || currentUser(c);
  if (!user) return c.text('Not signed in\n', 401);
  const id = Number(String(c.req.param('id')).replace(/^f/i, ''));
  const f = get('SELECT * FROM files WHERE id=?', id);
  if (!f || !get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', f.project_id, user.id)) return c.text('No such file\n', 404);
  const path = `${DATA_DIR}/files/${f.id}`;
  if (!existsSync(path)) return c.text('File missing on server\n', 410);
  const inline = /^(image\/(png|jpe?g|gif|webp)|text\/plain|application\/pdf)$/.test(f.mime) && c.req.query('inline') === '1';
  return new Response(Readable.toWeb(createReadStream(path)), {
    headers: {
      'Content-Type': inline ? f.mime : 'application/octet-stream',
      'Content-Length': String(statSync(path).size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Plugin self-update: the client fetches the published manifests here, since the GitHub repo is private.
app.get('/release/platforms/:platform/:a/:b?', (c) => {
  const { platform, a, b } = c.req.param();
  const rel = b ? `${a}/${b}` : a;
  const allowed = { 'claude-code': '.claude-plugin/plugin.json', codex: '.codex-plugin/plugin.json', antigravity: 'plugin.json' };
  if (allowed[platform] !== rel) return c.text('Not found\n', 404);
  const path = `${CLIENT_DIR}/platforms/${platform}/${rel}`;
  if (!existsSync(path)) return c.text('Not found\n', 404);
  return new Response(Readable.toWeb(createReadStream(path)), { headers: { 'Content-Type': 'application/json' } });
});
app.get('/release/weclaude-main.tar.gz', () => {
  const tar = spawn('tar', ['-czf', '-', '-C', CLIENT_DIR, '--transform', 's,^,weclaude-main/,', 'platforms/antigravity']);
  return new Response(Readable.toWeb(tar.stdout), { headers: { 'Content-Type': 'application/gzip' } });
});

app.route('/', web);
app.notFound((c) => c.text('Not found\n', 404));

// Agents left thinking when the server stopped are idle now.
run(`UPDATE agents SET state='idle' WHERE state='thinking'`);

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`weclaude server on :${port}`));
