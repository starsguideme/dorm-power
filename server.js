// 宿舍电费小账本：零依赖 Node 服务
// 双视图：管理员（口令）看全部明细并可录入；访客只看概览（取整后的余量与天数）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUSH_HOUR = 23;
const PUSH_MIN = 55;

function defaultData() {
  return { room: '', threshold: 15, pushToken: '', lastPushDate: '', ownerKey: '', guestKey: '', records: [] };
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Object.assign(defaultData(), d, { records: Array.isArray(d.records) ? d.records : [] });
  } catch (e) {
    return defaultData();
  }
}

let data = loadData();

function saveData() {
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('save failed', e.message);
  }
}

function readings() {
  return data.records.filter(r => r.type === 'reading').sort((a, b) => a.ts - b.ts);
}

function stats() {
  const rs = readings();
  if (!rs.length) return null;
  const last = rs[rs.length - 1];
  let daily = null;
  if (rs.length >= 2) {
    const first = rs[0];
    const days = (last.ts - first.ts) / 86400000;
    const used = first.value - last.value;
    if (days >= 0.2 && used > 0) daily = used / days;
  }
  const daysLeft = daily && daily > 0 ? last.value / daily : null;
  return { last, daily, daysLeft };
}

function roundBalance(v) {
  if (v <= 20) return Math.round(v);
  return Math.round(v / 5) * 5;
}
function roundDays(d) {
  if (d === null || d === undefined) return null;
  if (d >= 100) return '99+';
  return Math.max(0, Math.round(d));
}
function statusOf(s) {
  if (!s) return 'unknown';
  const thr = Number(data.threshold) || 15;
  if (s.last.value <= thr) return 'low';
  if (s.daysLeft && s.daysLeft <= 7) return 'soon';
  return 'ok';
}

function publicState() {
  const s = stats();
  return {
    scope: 'guest',
    room: data.room || '',
    needGuestKey: !!data.guestKey,
    status: statusOf(s),
    balance: s ? roundBalance(s.last.value) : null,
    daysLeft: s ? roundDays(s.daysLeft) : null,
    updatedAt: s ? s.last.ts : null
  };
}

function ownerState() {
  const s = stats();
  return {
    scope: 'owner',
    room: data.room,
    threshold: data.threshold,
    hasToken: !!data.pushToken,
    hasKey: !!data.ownerKey,
    hasGuestKey: !!data.guestKey,
    records: data.records.slice().sort((a, b) => b.ts - a.ts),
    stats: s ? { balance: s.last.value, daily: s.daily, daysLeft: s.daysLeft, lastTs: s.last.ts } : null,
    summary: summaryText()
  };
}

function summaryText() {
  const s = stats();
  const room = data.room || '本宿舍';
  const thr = Number(data.threshold) || 15;
  const time = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const lines = ['宿舍电费提醒', '', '房间：' + room];
  if (!s) {
    lines.push('余量：还没有读数', '', '先去记一次电表读数，之后就能预测了。');
  } else {
    lines.push('余量：' + s.last.value.toFixed(1) + ' 度');
    lines.push('日均：' + (s.daily ? s.daily.toFixed(2) + ' 度/天' : '数据不足（需两次读数）'));
    lines.push('预计可用：' + (s.daysLeft ? (s.daysLeft >= 100 ? '99+' : s.daysLeft.toFixed(1)) + ' 天' : '—'));
    lines.push('');
    if (s.last.value <= thr) lines.push('状态：已低于 ' + thr + ' 度阈值，该充值了');
    else if (s.daysLeft && s.daysLeft <= 7) lines.push('状态：不到一周，建议这周充值');
    else lines.push('状态：正常');
  }
  lines.push('', '（数据时间 ' + time + '）');
  return lines.join('\n');
}

function sendPush(title, content) {
  return new Promise((resolve) => {
    const token = (data.pushToken || '').trim();
    if (!token) return resolve({ ok: false, msg: '未配置 pushToken' });
    const html = String(content).split('\n').map(l => l.replace(/</g, '&lt;')).join('<br>');
    const body = JSON.stringify({ token, title, content: html, template: 'html' });
    const req = http.request({
      hostname: 'www.pushplus.plus',
      path: '/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) {}
        if (parsed && Number(parsed.code) === 200) resolve({ ok: true, msg: 'ok' });
        else if (parsed) resolve({ ok: false, msg: 'code ' + parsed.code + '：' + (parsed.data || parsed.msg || '推送被拒绝') });
        else resolve({ ok: false, msg: '返回无法解析：' + buf.slice(0, 120) });
      });
    });
    req.on('error', e => resolve({ ok: false, msg: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, msg: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let pushing = false;
async function tickPush() {
  const now = new Date();
  if (now.getHours() !== PUSH_HOUR || now.getMinutes() !== PUSH_MIN) return;
  if (pushing || data.lastPushDate === todayStr()) return;
  pushing = true;
  const r = await sendPush('宿舍电费提醒', summaryText());
  pushing = false;
  if (r.ok) { data.lastPushDate = todayStr(); saveData(); console.log('push sent'); }
  else console.log('push failed', r.msg);
}
setInterval(tickPush, 30 * 1000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };


let htmlTemplate = null;
try {
  const raw = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  htmlTemplate = raw;
} catch (e) {
  console.error('index.html missing', e.message);
}

function sendCompressed(req, res, code, type, payload, maxAgeSec) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const accepts = String(req.headers['accept-encoding'] || '').indexOf('gzip') >= 0;
  const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=' + (maxAgeSec || 0) + ', must-revalidate' };
  if (accepts && buf.length > 512) {
    const gz = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(code, headers);
    return res.end(gz);
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(buf);
}

function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); } });
  });
}

function keyMatches(k) {
  if (!data.ownerKey) return false;
  const a = Buffer.from(String(k || ''));
  const b = Buffer.from(String(data.ownerKey));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function guestOk(req) {
  if (!data.guestKey) return true;
  const k = req.headers['x-guest-key'] || '';
  const a = Buffer.from(String(k));
  const b = Buffer.from(String(data.guestKey));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isOwner(req, url) {
  if (!data.ownerKey) return false;
  const h = req.headers['x-owner-key'];
  const k = h || url.searchParams.get('key') || '';
  return keyMatches(k);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/state' && req.method === 'GET') {
    if (!data.ownerKey) {
      const g = publicState();
      g.scope = 'setup';
      return sendJSON(res, 200, g);
    }
    return sendJSON(res, 200, isOwner(req, url) ? ownerState() : publicState());
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const k = String(b.key || '').trim();
    if (!data.ownerKey) {
      if (!k) return sendJSON(res, 400, { ok: false, msg: '口令不能为空' });
      data.ownerKey = k;
      saveData();
      return sendJSON(res, 200, { ok: true, msg: '已设置管理口令' });
    }
    if (keyMatches(k)) return sendJSON(res, 200, { ok: true });
    return sendJSON(res, 401, { ok: false, msg: '口令不对' });
  }

  if (url.pathname === '/api/change-key' && req.method === 'POST') {
    if (!isOwner(req, url)) return sendJSON(res, 403, { ok: false, msg: '只有管理员能改口令' });
    const b = await readBody(req);
    const nk = String(b.key || '').trim();
    if (nk.length < 4) return sendJSON(res, 400, { ok: false, msg: '口令至少 4 位' });
    data.ownerKey = nk;
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  const isWrite = req.method === 'POST' || req.method === 'DELETE';
  if (isWrite && !data.ownerKey && url.pathname !== '/api/login' && url.pathname !== '/api/guest-login') {
    return sendJSON(res, 428, { ok: false, msg: '请先设置管理口令' });
  }

  const needOwner = ['/api/settings', '/api/push-test', '/api/push-now', '/api/reset'];
  if (needOwner.indexOf(url.pathname) >= 0 && !isOwner(req, url)) {
    return sendJSON(res, 403, { ok: false, msg: '只有管理员能改数据' });
  }
  if (url.pathname.indexOf('/api/record/') === 0 && req.method === 'DELETE' && !isOwner(req, url)) {
    return sendJSON(res, 403, { ok: false, msg: '只有管理员能删除记录' });
  }

  if ((url.pathname === '/api/reading' || url.pathname === '/api/charge') && req.method === 'POST') {
    if (!isOwner(req, url) && !guestOk(req)) {
      return sendJSON(res, 403, { ok: false, msg: '请先输入舍友口令' });
    }
  }

  if (url.pathname === '/api/guest-login' && req.method === 'POST') {
    const b = await readBody(req);
    const k = String(b.key || '').trim();
    if (!data.guestKey) return sendJSON(res, 200, { ok: true, open: true });
    if (guestOk({ headers: { 'x-guest-key': k } })) return sendJSON(res, 200, { ok: true });
    return sendJSON(res, 401, { ok: false, msg: '舍友口令不对' });
  }

  if (url.pathname === '/api/set-guest-key' && req.method === 'POST') {
    if (!isOwner(req, url)) return sendJSON(res, 403, { ok: false, msg: '只有管理员能设置' });
    const b = await readBody(req);
    data.guestKey = String(b.key || '').trim().slice(0, 20);
    saveData();
    return sendJSON(res, 200, { ok: true, cleared: !data.guestKey });
  }

  if (url.pathname === '/api/reading' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Number(b.value);
    if (!isFinite(v) || v < 0) return sendJSON(res, 400, { ok: false, msg: '读数无效' });
    data.records.push({ id: Date.now() + Math.floor(Math.random() * 1000), type: 'reading', value: v, ts: Date.now(), who: String(b.who || '').slice(0, 20) });
    saveData();
    return sendJSON(res, 200, { ok: true, summary: summaryText() });
  }

  if (url.pathname === '/api/charge' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Number(b.value);
    if (!isFinite(v) || v <= 0) return sendJSON(res, 400, { ok: false, msg: '度数无效' });
    data.records.push({ id: Date.now() + Math.floor(Math.random() * 1000), type: 'charge', value: v, ts: Date.now(), who: String(b.who || '').slice(0, 20) });
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname.indexOf('/api/record/') === 0 && req.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop());
    const before = data.records.length;
    data.records = data.records.filter(r => r.id !== id);
    if (data.records.length === before) return sendJSON(res, 404, { ok: false, msg: '记录不存在' });
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    data.records = [];
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.room === 'string') data.room = b.room.slice(0, 40);
    if (isFinite(Number(b.threshold)) && Number(b.threshold) > 0) data.threshold = Number(b.threshold);
    if (typeof b.pushToken === 'string') data.pushToken = b.pushToken.trim().slice(0, 120);
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/push-test' && req.method === 'POST') {
    const r = await sendPush('宿舍电费提醒（测试）', summaryText());
    return sendJSON(res, 200, { ok: r.ok, msg: r.msg });
  }

  if (url.pathname === '/api/push-now' && req.method === 'POST') {
    const r = await sendPush('宿舍电费提醒', summaryText());
    if (r.ok) { data.lastPushDate = todayStr(); saveData(); }
    return sendJSON(res, 200, { ok: r.ok, msg: r.msg });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const boot = isOwner(req, url) ? ownerState() : publicState();
    const tag = '<script>window.__BOOT__=' + JSON.stringify(boot).replace(/</g, '\\u003c') + ';</script>';
    const html = (htmlTemplate || '').replace('<script>', tag + '<script>');
    return sendCompressed(req, res, 200, 'text/html; charset=utf-8', html, 30);
  }

  let filePath = path.join(__dirname, path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, ''));
  if (filePath.indexOf(__dirname) !== 0) return sendJSON(res, 403, { ok: false });
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    sendCompressed(req, res, 200, type, buf, 300);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('dorm-power listening on ' + PORT));
