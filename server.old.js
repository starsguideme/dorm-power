// 宿舍电费小账本：零依赖 Node 服务
// 提供页面 + JSON 接口 + 每晚定时微信推送（PushPlus）
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUSH_HOUR = 23;
const PUSH_MIN = 55;

function defaultData() {
  return { room: '', threshold: 15, pushToken: '', lastPushDate: '', records: [] };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
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

function summaryText() {
  const s = stats();
  const room = data.room || '本宿舍';
  const thr = Number(data.threshold) || 15;
  const time = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const lines = [];
  lines.push('宿舍电费提醒');
  lines.push('');
  lines.push('房间：' + room);
  if (!s) {
    lines.push('余量：还没有读数');
    lines.push('');
    lines.push('先去记一次电表读数，之后就能预测了。');
  } else {
    lines.push('余量：' + s.last.value.toFixed(1) + ' 度');
    lines.push('日均：' + (s.daily ? s.daily.toFixed(2) + ' 度/天' : '数据不足（需两次读数）'));
    lines.push('预计可用：' + (s.daysLeft ? (s.daysLeft >= 100 ? '99+' : s.daysLeft.toFixed(1)) + ' 天' : '—'));
    lines.push('');
    if (s.last.value <= thr) lines.push('状态：已低于 ' + thr + ' 度阈值，该充值了');
    else if (s.daysLeft && s.daysLeft <= 7) lines.push('状态：不到一周，建议这周充值');
    else lines.push('状态：正常');
  }
  lines.push('');
  lines.push('（数据时间 ' + time + '）');
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
        if (parsed && Number(parsed.code) === 200) {
          resolve({ ok: true, msg: 'ok' });
        } else if (parsed) {
          resolve({ ok: false, msg: 'code ' + parsed.code + '：' + (parsed.data || parsed.msg || '推送被拒绝') });
        } else {
          resolve({ ok: false, msg: '返回无法解析：' + buf.slice(0, 120) });
        }
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
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

let pushing = false;
async function tickPush() {
  const now = new Date();
  if (now.getHours() !== PUSH_HOUR || now.getMinutes() !== PUSH_MIN) return;
  if (pushing) return;
  if (data.lastPushDate === todayStr()) return;
  pushing = true;
  const r = await sendPush('宿舍电费提醒', summaryText());
  pushing = false;
  if (r.ok) {
    data.lastPushDate = todayStr();
    saveData();
    console.log('push sent', r.msg);
  } else {
    console.log('push failed', r.msg);
  }
}
setInterval(tickPush, 30 * 1000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const s = stats();
    return sendJSON(res, 200, {
      room: data.room,
      threshold: data.threshold,
      hasToken: !!data.pushToken,
      records: data.records.slice().sort((a, b) => b.ts - a.ts),
      stats: s ? { balance: s.last.value, daily: s.daily, daysLeft: s.daysLeft, lastTs: s.last.ts } : null,
      summary: summaryText()
    });
  }

  if (url.pathname === '/api/reading' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Number(b.value);
    if (!isFinite(v) || v < 0) return sendJSON(res, 400, { ok: false, msg: '读数无效' });
    data.records.push({ id: Date.now() + Math.floor(Math.random() * 1000), type: 'reading', value: v, ts: Date.now(), who: (b.who || '').slice(0, 20) });
    saveData();
    return sendJSON(res, 200, { ok: true, summary: summaryText() });
  }

  if (url.pathname === '/api/charge' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Number(b.value);
    if (!isFinite(v) || v <= 0) return sendJSON(res, 400, { ok: false, msg: '度数无效' });
    data.records.push({ id: Date.now() + Math.floor(Math.random() * 1000), type: 'charge', value: v, ts: Date.now(), who: (b.who || '').slice(0, 20) });
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname.startsWith('/api/record/') && req.method === 'DELETE') {
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

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(__dirname)) return sendJSON(res, 403, { ok: false });
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('dorm-power listening on ' + PORT);
});
