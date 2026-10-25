import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, makeIntent } from './trade-intent.mjs';
import { makeProvider, recognize } from './recognize.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const provider = makeProvider();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && assets.has(pathname)) {
    const [file, type] = assets.get(pathname);
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(readFileSync(join(root, file)));
    return;
  }
  if (req.method === 'POST' && (pathname === '/api/inspect' || pathname === '/api/intent')) {
    try {
      let input = '';
      for await (const chunk of req) {
        input += chunk;
        if (input.length > 1024) return json(res, 413, { error: '输入过大' });
      }
      const payload = JSON.parse(input);
      if (pathname === '/api/intent') {
        try { return json(res, 200, makeIntent(payload)); }
        catch (error) { return json(res, 400, { error: error.message }); }
      }
      const { token } = payload;
      if (!isAddress(token)) return json(res, 400, { error: '请输入完整合约地址' });
      const found = await recognize(provider, token);
      return json(res, 200, found || { platform: null, token, phase: '未在示例支持的登记中识别', quote: null });
    } catch {
      return json(res, 502, { error: '链上查询失败，请检查 RPC 或稍后重试' });
    }
  }
  json(res, 404, { error: 'not_found' });
});
server.listen(port, host, () => console.log(`Demo listening on ${host}:${port}`));
