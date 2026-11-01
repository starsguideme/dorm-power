// 宿舍电费小账本：零依赖 Node 服务
// 双视图：管理员（口令）看全部明细并可录入；访客只看概览（取整后的余量与天数）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const https = require('https');

const PORT = process.env.PORT || 3000;
// DATA_FILE 允许用环境变量指定（平台挂了持久盘时指过去）；默认仍在代码目录
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
// 同目录备份：只防「误覆盖」不防「容器重建」，所以还必须能导出到容器外
const BAK_FILE = DATA_FILE + '.bak';
// 平台升级会清 data.json，把 token 放环境变量即可在升级后自动恢复
const ENV_PUSH_TOKEN = (process.env.PUSH_TOKEN || '').trim();

const PUSH_HOUR = 23;
const PUSH_MIN = 55;

// —— 统一用东八区，避免容器时区导致推送时间错位 ——
// 放在 loadData/saveData 之前：备份要按北京时间切日，函数声明虽会提升，但它依赖的 BJ_OFFSET 是 const（TDZ）
const BJ_OFFSET = 8 * 3600 * 1000;
function bjParts(ts) {
  const d = new Date((ts || Date.now()) + BJ_OFFSET);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    y: y, m: m, day: day,
    hh: d.getUTCHours(), mm: d.getUTCMinutes(),
    date: y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0')
  };
}
function bjDateStr(ts) { return bjParts(ts).date; }
function todayStr() { return bjDateStr(Date.now()); }

function defaultData() {
  return { room: '', threshold: 15, people: 6, pushToken: '', lastPushDate: '', lastPush: null, cronSecret: '', ownerKey: '', guestKey: '', records: [], logs: [] };
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Object.assign(defaultData(), d, { records: Array.isArray(d.records) ? d.records : [] });
  } catch (e) {
    return defaultData();
  }
}

// 每日首次写入前，把「昨天结束时的好数据」留一份 .bak
// 用文件 mtime 判断今天备过没有，不额外往 data.json 里加字段
function backupOncePerDay() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    if (fs.existsSync(BAK_FILE)) {
      const st = fs.statSync(BAK_FILE);
      if (bjDateStr(st.mtimeMs) === todayStr()) return;
    }
    fs.copyFileSync(DATA_FILE, BAK_FILE);
  } catch (e) {
    console.error('backup failed', e.message);
  }
}

function saveData(skipBackup) {
  if (!skipBackup) backupOncePerDay();
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('save failed', e.message);
  }
}

let data = loadData();

// 启动自检：平台升级/重建后 data.json 是空的，但 .bak 可能还活着 → 自动捞回来
// 这里必须 saveData(true)：否则会先触发备份，把空文件盖到唯一的好备份上
if (!data.records.length && fs.existsSync(BAK_FILE)) {
  try {
    const bak = JSON.parse(fs.readFileSync(BAK_FILE, 'utf8'));
    if (bak && Array.isArray(bak.records) && bak.records.length) {
      data = Object.assign(defaultData(), bak, { records: bak.records });
      data.logs = Array.isArray(data.logs) ? data.logs : [];
      data.logs.push({ ts: Date.now(), action: '自动恢复', detail: '从 .bak 恢复 ' + bak.records.length + ' 条记录', who: 'system', ok: true });
      saveData(true);
      console.warn('[restore] data.json 为 0 条记录，已从 ' + BAK_FILE + ' 恢复 ' + bak.records.length + ' 条');
    }
  } catch (e) {
    console.error('restore from bak failed', e.message);
  }
}

if (!data.cronSecret) { data.cronSecret = crypto.randomBytes(8).toString('hex'); saveData(); }

const LOG_MAX = 300;
function addLog(action, detail, who, ok) {
  try {
    data.logs.push({ ts: Date.now(), action: action, detail: String(detail || '').slice(0, 120), who: who || '', ok: ok === undefined ? null : !!ok });
    if (data.logs.length > LOG_MAX) data.logs = data.logs.slice(-LOG_MAX);
  } catch (e) {}
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

function estimate() {
  const s = stats();
  if (!s) return null;
  const elapsed = Math.max(0, (Date.now() - s.last.ts) / 86400000);
  const daily = s.daily;
  const est = daily ? Math.max(0, s.last.value - daily * elapsed) : s.last.value;
  const daysLeft = daily && daily > 0 ? est / daily : null;
  const cutAt = daysLeft !== null ? Date.now() + daysLeft * 86400000 : null;
  return { s: s, elapsed: elapsed, est: est, daily: daily, daysLeft: daysLeft, cutAt: cutAt };
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
  const e = estimate();
  const bal = e ? e.est : s.last.value;
  const dl = e && e.daysLeft !== null ? e.daysLeft : s.daysLeft;
  if (bal <= thr) return 'low';
  if (dl && dl <= 7) return 'soon';
  return 'ok';
}

function publicState() {
  const s = stats();
  const e = estimate();
  return {
    scope: 'guest',
    room: data.room || '',
    needGuestKey: !!data.guestKey,
    status: statusOf(s),
    balance: e ? roundBalance(e.est) : null,
    daysLeft: e ? roundDays(e.daysLeft) : null,
    updatedAt: s ? s.last.ts : null,
    staleDays: e ? Math.floor(e.elapsed) : null,
    serverTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    bjNow: bjParts(Date.now())
  };
}

function ownerState() {
  const s = stats();
  const e = estimate();
  return {
    scope: 'owner',
    room: data.room,
    threshold: data.threshold,
    people: data.people || 6,
    hasToken: !!data.pushToken,
    cronSecret: data.cronSecret || '',
    lastPush: data.lastPush || null,
    serverTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    bjNow: bjParts(Date.now()),
    hasKey: !!data.ownerKey,
    hasGuestKey: !!data.guestKey,
    records: data.records.slice().sort((a, b) => b.ts - a.ts),
    logs: (data.logs || []).slice(-60).reverse(),
    stats: s ? {
      balance: s.last.value,
      daily: s.daily,
      daysLeft: s.daysLeft,
      lastTs: s.last.ts,
      estBalance: e ? e.est : null,
      estDaysLeft: e ? e.daysLeft : null,
      elapsedDays: e ? e.elapsed : 0,
      cutAt: e ? e.cutAt : null
    } : null,
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
    const e2 = estimate();
    if (e2 && e2.daily && e2.elapsed >= 0.5) {
      lines.push('估算余量：' + e2.est.toFixed(1) + ' 度（' + Math.floor(e2.elapsed) + ' 天前实测 ' + s.last.value.toFixed(1) + ' 度）');
    } else {
      lines.push('余量：' + s.last.value.toFixed(1) + ' 度');
    }
    lines.push('日均：' + (s.daily ? s.daily.toFixed(2) + ' 度/天' : '数据不足（需两次读数）'));
    const dl = e2 && e2.daysLeft !== null ? e2.daysLeft : s.daysLeft;
    lines.push('预计可用：' + (dl ? (dl >= 100 ? '99+' : dl.toFixed(1)) + ' 天' : '—'));
    if (e2 && e2.elapsed >= 1) lines.push('距上次读数：' + Math.floor(e2.elapsed) + ' 天');
    const ppl = Number(data.people) || 6;
    if (e2 && e2.daily) lines.push('人均：' + (e2.daily / ppl).toFixed(1) + ' 度/人/天（约 ' + Math.round(e2.daily / ppl * 0.55 * 30) + ' 元/人/月，6 人分摊）'.replace('6 人', ppl + ' 人'));
    if (e2 && e2.cutAt) {
      const d2 = new Date(e2.cutAt);
      lines.push('预计断电：' + (d2.getMonth() + 1) + ' 月 ' + d2.getDate() + ' 日前后');
    }
    lines.push('');
    if (e2 && e2.est <= thr) lines.push('状态：已低于 ' + thr + ' 度阈值，该充值了');
    else if (dl && dl <= 7) lines.push('状态：不到一周，建议这周充值');
    else lines.push('状态：正常');
  }
  lines.push('', '（数据时间 ' + time + '）');
  return lines.join('\n');
}

function sendPush(title, content) {
  return new Promise((resolve) => {
    // 环境变量优先：平台升级会清 data.json，token 配在平台环境变量里就不会跟着丢
    const token = ENV_PUSH_TOKEN || (data.pushToken || '').trim();
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


let pushing = false;
function inPushWindow() {
  const p = bjParts(Date.now());
  const mins = p.hh * 60 + p.mm;
  const start = PUSH_HOUR * 60 + PUSH_MIN;
  return mins >= start && mins <= start + 29;
}

async function doPush(tag) {
  if (pushing) return { ok: false, msg: 'busy' };
  pushing = true;
  const r = await sendPush('宿舍电费提醒', summaryText());
  pushing = false;
  data.lastPush = { at: Date.now(), date: bjDateStr(Date.now()), ok: !!r.ok, msg: r.msg, tag: tag };
  addLog('推送', (r.ok ? '成功' : '失败：' + r.msg) + '（' + tag + '）', 'system', r.ok);
  if (r.ok) { data.lastPushDate = bjDateStr(Date.now()); }
  saveData();
  console.log('push', tag, r.ok ? 'ok' : r.msg);
  return r;
}

async function tickPush() {
  if (data.lastPushDate === todayStr()) return;
  if (!inPushWindow()) return;
  await doPush('auto');
}

// —— 自我唤醒：在推送窗口前主动请求自己的公网地址，避免容器休眠导致定时器不跑 ——
let lastWakeKey = '';
function selfWake() {
  if (!lastHost) return;
  const p = bjParts(Date.now());
  const mins = p.hh * 60 + p.mm;
  const marks = [23 * 60 + 47, 23 * 60 + 53, 23 * 60 + 57];
  const hit = marks.indexOf(mins) >= 0;
  if (!hit) return;
  const key = p.date + ':' + mins;
  if (lastWakeKey === key) return;
  lastWakeKey = key;
  const path = '/?sharecode=' + encodeURIComponent(lastShareCode) + '&wake=1';
  const req2 = https.request({ hostname: lastHost, path: path, method: 'GET', timeout: 8000 }, (r) => { r.resume(); });
  req2.on('error', (e) => console.log('wake failed', e.message));
  req2.on('timeout', () => { req2.destroy(); });
  req2.end();
  console.log('self-wake sent', p.hh + ':' + p.mm);
}
setInterval(selfWake, 45 * 1000);

setInterval(tickPush, 20 * 1000);
setTimeout(tickPush, 3 * 1000);

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


function parseTs(b) {
  if (b && typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    const t = new Date(b.date + 'T12:00:00').getTime();
    if (isFinite(t) && t > 946684800000) return t;
  }
  return Date.now();
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

let lastHost = null;
let lastShareCode = '';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.headers.host && req.headers.host.indexOf('localhost') < 0 && req.headers.host.indexOf('127.0.0.1') < 0) {
      lastHost = req.headers.host;
      const sc = url.searchParams.get('sharecode');
      if (sc) lastShareCode = sc;
    }
  } catch (e) {}

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
    if (keyMatches(k)) { addLog('登录', '管理员登录'); saveData(); return sendJSON(res, 200, { ok: true }); }
    return sendJSON(res, 401, { ok: false, msg: '口令不对' });
  }

  if (url.pathname === '/api/change-key' && req.method === 'POST') {
    if (!isOwner(req, url)) return sendJSON(res, 403, { ok: false, msg: '只有管理员能改口令' });
    const b = await readBody(req);
    const nk = String(b.key || '').trim();
    if (nk.length < 4) return sendJSON(res, 400, { ok: false, msg: '口令至少 4 位' });
    data.ownerKey = nk;
    addLog('改口令', '管理员口令已更新');
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  const isWrite = req.method === 'POST' || req.method === 'DELETE';
  // /api/import 必须豁免：平台升级后口令也一起没了，此时要靠导入把口令找回来
  if (isWrite && !data.ownerKey && url.pathname !== '/api/login' && url.pathname !== '/api/guest-login' && url.pathname !== '/api/import') {
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
    if (!data.guestKey) { addLog('登录', '舍友登录（未设口令）'); saveData(); return sendJSON(res, 200, { ok: true, open: true }); }
    if (guestOk({ headers: { 'x-guest-key': k } })) { addLog('登录', '舍友登录'); saveData(); return sendJSON(res, 200, { ok: true }); }
    return sendJSON(res, 401, { ok: false, msg: '舍友口令不对' });
  }

  if (url.pathname === '/api/set-guest-key' && req.method === 'POST') {
    if (!isOwner(req, url)) return sendJSON(res, 403, { ok: false, msg: '只有管理员能设置' });
    const b = await readBody(req);
    data.guestKey = String(b.key || '').trim().slice(0, 20);
    addLog('改口令', data.guestKey ? '设置舍友口令' : '取消舍友口令');
    saveData();
    return sendJSON(res, 200, { ok: true, cleared: !data.guestKey });
  }

  if (url.pathname === '/api/reading' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Number(b.value);
    if (!isFinite(v) || v < 0) return sendJSON(res, 400, { ok: false, msg: '读数无效' });

    // 异常校验：与历史日均偏离过大时要求二次确认
    const ts0 = parseTs(b);
    const rs0 = readings();
    const prev = rs0.length ? rs0[rs0.length - 1] : null;
    if (prev && !b.force) {
      const gapDays = (ts0 - prev.ts) / 86400000;
      const hist = stats() ? stats().daily : null;
      const sameDay = rs0.some(r => bjDateStr(r.ts) === bjDateStr(ts0));
      if (sameDay) {
        return sendJSON(res, 409, { ok: false, needConfirm: true, kind: 'duplicate',
          msg: '同一天已有读数，再录一条会让日均失真。确认要追加这条吗？（一般应删除旧的那条）' });
      }
      if (gapDays > 0.2 && v > prev.value) {
        return sendJSON(res, 409, { ok: false, needConfirm: true, kind: 'increase',
          msg: '读数比上次（' + prev.value.toFixed(1) + ' 度）还高。如果是刚充值，请确认后再保存。' });
      }
      if (gapDays > 0.2 && hist && hist > 0) {
        const implied = (prev.value - v) / gapDays;
        const dev = (implied - hist) / hist;
        if (Math.abs(dev) > 0.4) {
          return sendJSON(res, 409, { ok: false, needConfirm: true, kind: 'deviation',
            implied: implied, hist: hist, gapDays: gapDays,
            msg: '这几天日均 ' + implied.toFixed(1) + ' 度，历史日均 ' + hist.toFixed(1)
               + ' 度，相差 ' + Math.round(Math.abs(dev) * 100) + '%。数值可能记错，确认要保存吗？' });
        }
      }
    }
    const whoR = String(b.who || '').slice(0, 20) || (isOwner(req, url) ? '管理员' : '舍友');
    data.records.push({ id: Date.now() + Math.floor(Math.random() * 1000), type: 'reading', value: v, ts: parseTs(b), who: whoR });
    addLog('录读数', v.toFixed(1) + ' 度' + (b.date ? '（' + b.date + '）' : ''), whoR);
    saveData();
    return sendJSON(res, 200, { ok: true, summary: summaryText() });
  }

  if (url.pathname === '/api/charge' && req.method === 'POST') {
    const b = await readBody(req);
    const v = Number(b.value);
    if (!isFinite(v) || v <= 0) return sendJSON(res, 400, { ok: false, msg: '度数无效' });
    const whoC = String(b.who || '').slice(0, 20) || (isOwner(req, url) ? '管理员' : '舍友');
    data.records.push({ id: Date.now() + Math.floor(Math.random() * 1000), type: 'charge', value: v, ts: parseTs(b), who: whoC });
    addLog('记充值', v.toFixed(1) + ' 度', whoC);
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname.indexOf('/api/record/') === 0 && req.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop());
    const before = data.records.length;
    const gone = data.records.find(r => r.id === id);
    data.records = data.records.filter(r => r.id !== id);
    if (data.records.length === before) return sendJSON(res, 404, { ok: false, msg: '记录不存在' });
    addLog('删记录', (gone ? (gone.type === 'reading' ? '读数 ' : '充值 ') + gone.value.toFixed(1) + ' 度' : ''));
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    addLog('清空', '删除全部 ' + data.records.length + ' 条记录');
    data.records = [];
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.room === 'string') data.room = b.room.slice(0, 40);
    if (isFinite(Number(b.threshold)) && Number(b.threshold) > 0) data.threshold = Number(b.threshold);
    const diffs = [];
    if (typeof b.room === 'string' && b.room.slice(0, 40) !== data.room) diffs.push('房间 ' + (data.room || '空') + ' → ' + b.room.slice(0, 40));
    if (isFinite(Number(b.threshold)) && Number(b.threshold) !== data.threshold) diffs.push('阈值 ' + data.threshold + ' → ' + Number(b.threshold));
    if (isFinite(Number(b.people)) && Math.round(Number(b.people)) !== data.people) diffs.push('人数 ' + data.people + ' → ' + Math.round(Number(b.people)));
    if (typeof b.pushToken === 'string' && b.pushToken.trim() !== data.pushToken) diffs.push(b.pushToken.trim() ? '更新推送 token' : '清空推送 token');
    if (diffs.length) addLog('改设置', diffs.join('；'));
    if (typeof b.pushToken === 'string') data.pushToken = b.pushToken.trim().slice(0, 120);
    if (isFinite(Number(b.people)) && Number(b.people) >= 1 && Number(b.people) <= 20) data.people = Math.round(Number(b.people));
    saveData();
    return sendJSON(res, 200, { ok: true });
  }

  if (url.pathname === '/api/cron' && (req.method === 'GET' || req.method === 'POST')) {
    const secret = url.searchParams.get('secret') || '';
    if (!data.cronSecret) { data.cronSecret = crypto.randomBytes(8).toString('hex'); saveData(); }
    if (secret !== data.cronSecret) return sendJSON(res, 403, { ok: false, msg: 'secret 不对' });
    if (data.lastPushDate === todayStr()) return sendJSON(res, 200, { ok: true, skipped: '今天已推送' });
    const r = await doPush('cron');
    return sendJSON(res, 200, { ok: r.ok, msg: r.msg, at: bjParts(Date.now()).date });
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

  if (url.pathname === '/api/export' && req.method === 'GET') {
    if (!isOwner(req, url)) return sendJSON(res, 403, { ok: false, msg: '只有管理员能导出' });
    const fmt = String(url.searchParams.get('format') || 'json').toLowerCase();
    const stamp = bjDateStr(Date.now());
    const rows = data.records.slice().sort((a, b) => a.ts - b.ts);

    if (fmt === 'csv') {
      const cell = (v) => {
        const s = String(v === null || v === undefined ? '' : v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [['日期', '类型', '数值', '记录人'].join(',')];
      rows.forEach(r => lines.push(
        [bjDateStr(r.ts), r.type === 'reading' ? '读数' : '充值', r.value, r.who || ''].map(cell).join(',')
      ));
      // BOM 不能省：不加的话 Excel 打开中文全是乱码
      const buf = Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dorm-power-' + stamp + '.csv"',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      addLog('导出', 'csv 共 ' + rows.length + ' 条', '管理员');
      saveData();
      return res.end(buf);
    }

    if (fmt !== 'json') return sendJSON(res, 400, { ok: false, msg: 'format 只支持 json / csv' });
    // 默认导出全量（含口令与 token）：这是给「平台升级后一键恢复」用的备份，不是给外传的
    // 要脱敏加 &secret=0
    const withSecret = url.searchParams.get('secret') !== '0';
    const payload = { app: 'dorm-power', version: 1, exportedAt: Date.now(), exportedDate: stamp, data: Object.assign({}, data) };
    if (!withSecret) {
      delete payload.data.ownerKey;
      delete payload.data.guestKey;
      delete payload.data.pushToken;
      delete payload.data.cronSecret;
    }
    const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="dorm-power-' + stamp + '.json"',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    addLog('导出', 'json 共 ' + rows.length + ' 条' + (withSecret ? '（含口令）' : '（脱敏）'), '管理员');
    saveData();
    return res.end(buf);
  }

  if (url.pathname === '/api/import' && req.method === 'POST') {
    // 平台升级后 ownerKey 也丢了。如果导入也要管理员鉴权，恢复路径就依赖「被恢复的数据」→ 死锁。
    // 所以只有已设口令的库才校验身份；空库视为首次初始化，谁都能导（和 /api/login 首次设口令同一逻辑）
    if (data.ownerKey && !isOwner(req, url)) return sendJSON(res, 403, { ok: false, msg: '只有管理员能导入' });
    const b = await readBody(req);
    const src = (b && b.data && typeof b.data === 'object') ? b.data : b;   // 兼容直接贴 data.json 本体
    if (!src || typeof src !== 'object' || !Array.isArray(src.records)) {
      return sendJSON(res, 400, { ok: false, msg: '格式不对：需要导出的 JSON（或 data.json 本体）' });
    }
    if (src.records.length > 5000) return sendJSON(res, 400, { ok: false, msg: '记录超过 5000 条，拒绝导入' });

    const clean = [];
    for (const r of src.records) {
      if (!r || (r.type !== 'reading' && r.type !== 'charge')) continue;
      const v = Number(r.value);
      const ts = Number(r.ts);
      if (!isFinite(v) || !isFinite(ts)) continue;
      clean.push({ id: Number(r.id) || (ts + clean.length), type: r.type, value: v, ts: ts, who: String(r.who || '').slice(0, 20) });
    }
    const before = data.records.length;
    if (!clean.length && before > 0) {
      return sendJSON(res, 400, { ok: false, msg: '文件里没有有效记录，已拒绝（避免误清空 ' + before + ' 条）' });
    }
    // 覆盖前单独留一份，不动 .bak —— .bak 是「昨天好数据」的兜底，别被一次误导入毁掉
    try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE + '.import'); } catch (e) {}

    if (typeof src.room === 'string' && src.room) data.room = src.room.slice(0, 40);
    if (isFinite(Number(src.threshold)) && Number(src.threshold) > 0) data.threshold = Number(src.threshold);
    if (isFinite(Number(src.people)) && Number(src.people) >= 1 && Number(src.people) <= 20) data.people = Math.round(Number(src.people));
    if (typeof src.pushToken === 'string' && src.pushToken) data.pushToken = src.pushToken.slice(0, 120);
    if (typeof src.cronSecret === 'string' && src.cronSecret) data.cronSecret = src.cronSecret.slice(0, 64);
    if (typeof src.ownerKey === 'string' && src.ownerKey) data.ownerKey = src.ownerKey;
    if (typeof src.guestKey === 'string' && src.guestKey) data.guestKey = src.guestKey;
    if (typeof src.lastPushDate === 'string') data.lastPushDate = src.lastPushDate;
    data.records = clean;
    data.logs = Array.isArray(src.logs) ? src.logs.slice(-LOG_MAX) : [];
    data.logs.push({ ts: Date.now(), action: '导入', detail: '覆盖前 ' + before + ' 条 → 导入 ' + clean.length + ' 条', who: '管理员', ok: true });
    saveData(true);
    console.log('[import] restored ' + clean.length + ' records (was ' + before + ')');
    return sendJSON(res, 200, {
      ok: true, restored: clean.length, skipped: src.records.length - clean.length,
      before: before, backup: path.basename(BAK_FILE) + '.import'
    });
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
