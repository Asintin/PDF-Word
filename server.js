'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { convertPdf } = require('./lib/convert');

const PORT = 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUT_DIR = path.join(__dirname, '输出');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function uniqueOutputPath(baseName) {
  let name = baseName;
  let file = path.join(OUTPUT_DIR, name + '.docx');
  let n = 1;
  while (fs.existsSync(file)) {
    name = `${baseName}(${n})`;
    file = path.join(OUTPUT_DIR, name + '.docx');
    n += 1;
  }
  return file;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return send(res, 200, { 'Content-Type': MIME['.html'] }, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
  }

  if (req.method === 'GET' && !pathname.startsWith('/convert') && !pathname.startsWith('/open') && !pathname.startsWith('/ping')) {
    const filePath = path.join(PUBLIC_DIR, pathname);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      return send(res, 200, { 'Content-Type': MIME[ext] || 'application/octet-stream' }, fs.readFileSync(filePath));
    }
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
  }

  if (req.method === 'GET' && pathname === '/ping') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/convert') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        if (body.length === 0) throw new Error('未收到文件数据');
        const lang = url.searchParams.get('lang') || 'auto';
        const inName = url.searchParams.get('name') || 'result';

        const { docxBuf } = await convertPdf(body, lang, (msg) => console.log('[convert]', msg));

        const base = inName.replace(/\.pdf$/i, '');
        const outPath = uniqueOutputPath(base);
        fs.writeFileSync(outPath, docxBuf);
        sendJson(res, 200, { ok: true, file: outPath, fileName: path.basename(outPath) });
      } catch (e) {
        sendJson(res, 500, { error: e.message || String(e) });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/open') {
    const p = url.searchParams.get('path') || '';
    const resolved = path.resolve(p);
    if (!resolved.startsWith(OUTPUT_DIR)) return sendJson(res, 403, { error: '非法路径' });
    exec(`start "" "${resolved}"`, (err) => { if (err) console.error(err); });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/openfolder') {
    const p = url.searchParams.get('path') || '';
    const resolved = path.resolve(p);
    if (!resolved.startsWith(OUTPUT_DIR)) return sendJson(res, 403, { error: '非法路径' });
    exec(`explorer.exe /select,"${resolved}"`, (err) => { if (err) console.error(err); });
    return sendJson(res, 200, { ok: true });
  }

  send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
});

server.listen(PORT, () => {
  console.log('================================================');
  console.log('  PDF 转 Word 工具已启动');
  console.log('  浏览器地址:  http://localhost:' + PORT);
  console.log('  输出目录:    ' + OUTPUT_DIR);
  console.log('  关闭本窗口即可退出程序');
  console.log('================================================');
  const url = `http://localhost:${PORT}`;
  exec(`start "" "${url}"`, (err) => {
    if (err) console.log('请手动在浏览器打开：' + url);
  });
});
