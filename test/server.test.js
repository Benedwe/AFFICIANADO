const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let handleRequest;
let dataDir;
let remote = 1;
before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-state-'));
  process.env.DATA_DIR = dataDir;
  process.env.SITE_URL = 'https://aficionados.example';
  ({ handleRequest } = require('../server'));
});
after(() => { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });

function request(method, url, body, handler = handleRequest) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers: { host: 'localhost' }, socket: { remoteAddress: `test-${remote++}` } });
  const res = {
    headers: {}, status: 200, body: '', headersSent: false, destroyed: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.status = status; this.headersSent = true; Object.entries(headers).forEach(([k,v]) => this.setHeader(k,v)); },
    end(value = '') { this.body = String(value); this.done?.(); }
  };
  const done = new Promise(resolve => { res.done = resolve; });
  handler(req, res);
  if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return done.then(() => res);
}

test('public routes return the app and security headers', async () => {
  for (const route of ['/', '/about', '/pillars', '/opportunities', '/services', '/not-a-real-route']) {
    const response = await request('GET', route);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.equal(response.headers['x-frame-options'], 'DENY');
  }
  const health = await request('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
});

test('contact submissions validate, clean and persist', async () => {
  const invalid = await request('POST', '/api/contact', { name: 'A', email: 'bad', message: 'hello' });
  assert.equal(invalid.status, 400);
  const accepted = await request('POST', '/api/contact', { name: '<Ari>', email: 'ari@example.com', message: '<hello> there' });
  assert.equal(accepted.status, 201);
  const records = JSON.parse(fs.readFileSync(path.join(dataDir, 'contact-inquiries.json'), 'utf8'));
  assert.equal(records[0].name, 'Ari');
  assert.equal(records[0].message, 'hello there');
});

test('newsletter requires consent and prevents duplicate addresses', async () => {
  assert.equal((await request('POST', '/api/newsletter', { email: 'reader@example.com', consent: '' })).status, 400);
  assert.equal((await request('POST', '/api/newsletter', { email: 'reader@example.com', consent: 'yes' })).status, 201);
  assert.equal((await request('POST', '/api/newsletter', { email: 'reader@example.com', consent: 'yes' })).status, 200);
  const records = JSON.parse(fs.readFileSync(path.join(dataDir, 'newsletter-subscribers.json'), 'utf8'));
  assert.equal(records.length, 1);
});

test('sitemap and robots use configured public origin', async () => {
  const robots = await request('GET', '/robots.txt');
  const sitemap = await request('GET', '/sitemap.xml');
  assert.match(robots.body, /https:\/\/aficionados\.example\/sitemap\.xml/);
  assert.match(sitemap.body, /https:\/\/aficionados\.example\/opportunities/);
  const vercelSitemap = await request('GET', '/api/site/sitemap');
  const vercelRobots = await request('GET', '/api/site/robots');
  assert.match(vercelRobots.body, /https:\/\/aficionados\.example\/sitemap\.xml/);
  assert.match(vercelSitemap.body, /https:\/\/aficionados\.example\/opportunities/);
});

test('Vercel handler stores submissions in Upstash and deduplicates newsletters', async () => {
  const handler = require('../api/[...path]');
  const previousFetch = global.fetch;
  const previousEnv = {
    VERCEL: process.env.VERCEL,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN
  };
  const redis = new Map();
  const counters = new Map();
  const localFile = path.join(dataDir, 'newsletter-subscribers.json');
  const localBefore = fs.readFileSync(localFile, 'utf8');
  process.env.VERCEL = '1';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  global.fetch = async (_url, options) => {
    const [command, ...args] = JSON.parse(options.body);
    let result;
    if (command === 'EVAL') {
      const key = args[2];
      const count = (counters.get(key) || 0) + 1;
      counters.set(key, count);
      result = count;
    } else if (command === 'SET') {
      if (redis.has(args[0])) result = null;
      else { redis.set(args[0], args[1]); result = 'OK'; }
    } else throw new Error(`Unexpected Redis command ${command}`);
    return { ok: true, json: async () => ({ result }) };
  };
  try {
    const payload = { email: 'vercel-reader@example.com', consent: 'yes' };
    assert.equal((await request('POST', '/api/newsletter', payload, handler)).status, 201);
    assert.equal((await request('POST', '/api/newsletter', payload, handler)).status, 200);
    assert.equal(redis.size, 1);
    const [key, value] = [...redis.entries()][0];
    assert.match(key, /^newsletter:[a-f0-9]{64}$/);
    assert.equal(JSON.parse(value).email, payload.email);
    assert.equal(fs.readFileSync(localFile, 'utf8'), localBefore);
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
