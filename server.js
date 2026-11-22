const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const MAX_BODY = 16_384;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.VERCEL === '1';
const hits = new Map();
const stores = { contact: 'contact-inquiries.json', business: 'business-inquiries.json', partnerships: 'partnership-inquiries.json', newsletter: 'newsletter-subscribers.json' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const publicRoutes = ['/', '/about', '/pillars', '/team', '/portfolio', '/experiences', '/opportunities', '/community', '/services', '/partnerships', '/events', '/shop', '/contact', '/journal'];
function siteUrl(req) {
  const configured = process.env.SITE_URL;
  if (configured) { try { const url = new URL(configured); if (url.protocol === 'https:' || url.hostname === 'localhost') return url.origin; } catch {} }
  try {
    const protocol = process.env.VERCEL === '1' ? 'https:' : 'http:';
    return new URL(`${protocol}//${req.headers.host || `localhost:${PORT}`}`).origin;
  }
  catch { return `http://localhost:${PORT}`; }
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url && !token) return null;
  if (!url || !token) throw new Error('Redis configuration is incomplete.');
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') throw new Error('Redis URL must use HTTPS.');
  return { url: parsedUrl.origin, token };
}

async function redisCommand(command) {
  const config = getRedisConfig();
  if (!config) throw new Error('Persistent storage is not configured.');
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000)
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Storage returned an invalid response.'); }
  if (!response.ok || !payload || typeof payload !== 'object' || payload.error) throw new Error('Persistent storage request failed.');
  return payload.result;
}

async function rateLimit(req, res) {
  const now = Date.now();
  const forwardedFor = TRUST_PROXY && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
  const ip = forwardedFor || req.socket?.remoteAddress || 'unknown';
  try {
    const config = getRedisConfig();
    if (config) {
      const ipDigest = crypto.createHmac('sha256', config.token).update(ip).digest('hex');
      const script = "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count";
      const count = await redisCommand(['EVAL', script, '1', `rate:${ipDigest}`, '60000']);
      if (!Number.isSafeInteger(count)) throw new Error('Storage returned an invalid rate limit count.');
      if (count > 12) { json(res, 429, { error: 'Too many submissions. Please try again in a minute.' }); return false; }
      return true;
    }
    if (process.env.VERCEL === '1') {
      json(res, 503, { error: 'Submissions are temporarily unavailable.' });
      return false;
    }
  } catch {
    json(res, 503, { error: 'Submissions are temporarily unavailable.' });
    return false;
  }
  const record = hits.get(ip) || { start: now, count: 0 };
  if (now - record.start > 60_000) { record.start = now; record.count = 0; }
  record.count += 1;
  hits.set(ip, record);
  if (hits.size > 1000) for (const [key, value] of hits) if (now - value.start > 60_000) hits.delete(key);
  if (record.count > 12) { json(res, 429, { error: 'Too many submissions. Please try again in a minute.' }); return false; }
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        tooLarge = true;
        const error = new Error('Request is too large.');
        error.statusCode = 413;
        reject(error);
        req.resume();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Please send a valid form submission.')); }
    });
    req.on('error', reject);
  });
}
function clean(value, max = 1500) {
  return typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
async function submit(req, res, type) {
  try {
    if (!await rateLimit(req, res)) return;
    const body = await readBody(req);
    if (body.website) return json(res, 400, { error: 'Unable to process this submission.' });
    const entry = { id: crypto.randomUUID(), submittedAt: new Date().toISOString() };
    for (const [key, value] of Object.entries(body)) if (key !== 'website') entry[key] = clean(value, key === 'message' || key === 'description' ? 5000 : 500);
    if (!validEmail(entry.email || '')) return json(res, 400, { error: 'Enter a valid email address.' });
    const name = entry.name || entry.contactPerson;
    if (type !== 'newsletter' && (!name || !entry.message && !entry.description)) return json(res, 400, { error: 'Please complete the required fields.' });
    if (type === 'newsletter' && entry.consent !== 'yes') return json(res, 400, { error: 'Please consent to receive email updates.' });
    const redis = getRedisConfig();
    if (redis) {
      const key = type === 'newsletter'
        ? `newsletter:${crypto.createHmac('sha256', redis.token).update(entry.email.toLowerCase()).digest('hex')}`
        : `${type}:${entry.id}`;
      const result = await redisCommand(['SET', key, JSON.stringify(entry), 'NX']);
      if (type === 'newsletter' && result === null) return json(res, 200, { message: 'You are already subscribed.' });
      if (result !== 'OK') throw new Error('Persistent storage did not confirm the submission.');
    } else {
      if (process.env.VERCEL === '1') {
        return json(res, 503, { error: 'Submissions are temporarily unavailable.' });
      }
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      const file = path.join(DATA_DIR, stores[type]);
      let records = [];
      try { records = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (type === 'newsletter' && records.some(item => item.email.toLowerCase() === entry.email.toLowerCase())) return json(res, 200, { message: 'You are already subscribed.' });
      records.push(entry);
      fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    }
    return json(res, 201, { message: 'Thanks. Your message has been received.' });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) json(res, error.statusCode || (error instanceof SyntaxError ? 400 : 500), { error: error.statusCode === 413 || error instanceof SyntaxError ? error.message : 'Unable to save your submission.' });
  }
}
function staticFile(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, 'public', relative);
  if (!file.startsWith(path.resolve(ROOT, 'public') + path.sep) && file !== path.resolve(ROOT, 'public/index.html')) return json(res, 403, { error: 'Forbidden.' });
  fs.readFile(file, (error, content) => {
    if (error) return fs.readFile(path.join(ROOT, 'public/index.html'), (fallbackError, html) => {
      if (fallbackError) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(html);
    });
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(content);
  });
}
function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://images.unsplash.com data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
    const origin = siteUrl(req);
    const entries = publicRoutes.map(route => `<url><loc>${origin}${route === '/' ? '/' : route}</loc></url>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
  }
  if (req.method === 'GET' && url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`User-agent: *\nAllow: /\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
  }
  if (req.method === 'GET' && url.pathname === '/api/site/sitemap') {
    const origin = siteUrl(req);
    const entries = publicRoutes.map(route => `<url><loc>${origin}${route === '/' ? '/' : route}</loc></url>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
  }
  if (req.method === 'GET' && url.pathname === '/api/site/robots') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`User-agent: *\nAllow: /\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
  }
  const match = url.pathname.match(/^\/api\/(contact|business|partnerships|newsletter)$/);
  if (req.method === 'POST' && match) return submit(req, res, match[1]);
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  try { staticFile(req, res, url.pathname); } catch { json(res, 400, { error: 'Invalid path.' }); }
}
const server = http.createServer(handleRequest);
if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`AFICIONADOS STATE listening on ${HOST}:${server.address().port}`));
  const shutdown = signal => {
    console.log(`${signal} received; closing HTTP server.`);
    server.close(error => { if (error) { console.error('Graceful shutdown failed.', error); process.exitCode = 1; } });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
module.exports = { handleRequest };
