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

function request(method, url, body) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers: { host: 'localhost' }, socket: { remoteAddress: `test-${remote++}` } });
  const res = {
    headers: {}, status: 200, body: '', headersSent: false, destroyed: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.status = status; this.headersSent = true; Object.entries(headers).forEach(([k,v]) => this.setHeader(k,v)); },
    end(value = '') { this.body = String(value); this.done?.(); }
  };
  const done = new Promise(resolve => { res.done = resolve; });
  handleRequest(req, res);
  if (body !== undefined) queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
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
});
