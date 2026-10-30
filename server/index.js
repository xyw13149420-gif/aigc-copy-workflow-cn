/* 单端口 HTTP 服务：只负责托管静态站点。
 *
 * 数据和模型都在云服务里：
 *   商品库 / 生成记录 → 云数据库（浏览器直接用 SDK 读写，按域名 Origin 校验）
 *   文案生成         → 云端免密钥模型通道
 * 所以这里没有任何密钥、没有 /api、也不需要数据库 —— 只把 public/ 发出去。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch (e) {
    res.writeHead(400); return res.end('bad request');
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    const type = MIME[ext] || 'application/octet-stream';
    /* 带 ?v=<内容指纹> 的地址才允许长缓存（内容一变地址就变，缓存天然作废）；
       不带指纹的一律 no-cache 回源校验。之前的坑就是 HTML 不缓存、app.js 缓存 7 天，
       页面更新后浏览器仍在跑旧脚本，下拉和「生成文案」会一起失灵。 */
    const versioned = /[?&]v=[\w.-]+/.test(req.url || '');
    const cache = isHtml ? 'no-cache' : (versioned ? 'public, max-age=604800, immutable' : 'no-cache');

    // iOS Safari 播 <video> 必须支持 Range，否则只能播到缓冲区
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
          return res.end();
        }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cache,
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': cache,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, static: true }));
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] http://localhost:${PORT} · 静态托管 public/ · 数据与模型走云服务`);
});
