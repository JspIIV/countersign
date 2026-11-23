// Serve the page and the node service together, as Vercel does: docs/ as static files, /api/node as the function.
//   NODE_KEY=0x... node server/local.mjs [port]
import http from 'http'; import fs from 'fs'; import path from 'path'; import url from 'url';
const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const { default: node } = await import('../api/node.mjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.argv[2] || 8410);
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/node') {
    let body = ''; for await (const c of req) body += c;
    const shim = { setHeader: (k, v) => res.setHeader(k, v), status(c) { res.statusCode = c; return this; },
      json(j) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); return this; }, end() { res.end(); return this; } };
    return node({ method: req.method, query: Object.fromEntries(u.searchParams), body, url: req.url }, shim);
  }
  const file = path.join(ROOT, 'docs', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
  if (!file.startsWith(path.join(ROOT, 'docs')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`countersign on http://localhost:${port}`));
