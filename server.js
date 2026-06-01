'use strict';

// =============================================================================
// カウントダウンタイマー オーバーレイ サーバー
//
// 構成: このサーバー1つで
//   - /          → ディレクター操作盤 (director.html)
//   - /overlay   → OBS ブラウザソース (overlay.html)
//   を配信し、WebSocket で状態を全クライアントに同期する。
//
// 時計ズレ耐性:
//   サーバーは「running なら remainingMs と anchorTime (単調時計) を保持」し、
//   送信時に "その瞬間の残り時間" を計算して remainingMs として配る。
//   クライアントは受信時刻 (ローカル performance.now) を基準に、ローカル経過だけで
//   表示を進める。マシン間で絶対時刻を比較しないので時計ズレの影響を受けない。
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

// 単調時計 (NTP 同期や手動時刻変更の影響を受けない)。タイマー計算は全てこれを使う。
const monoNow = () => performance.now();

const PORT = 8090; // yt-monitor (8080) と被らないよう 8090
const STATE_FILE = path.join(__dirname, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- canonical state -------------------------------------------------------
// running 状態と anchorTime は永続化しない (再起動時は停止状態に戻す)。
const DEFAULT_STATE = {
  // timer
  durationMs: 5 * 60 * 1000, // リセット時に戻る既定の長さ
  // zero behavior
  zeroMode: 'blink',          // 'blink' | 'countup' | 'text'
  zeroText: 'まもなく開始',
  // design
  fontKey: 'system',
  fontFamily: '',             // CSS font-family。空ならシステム
  fontSize: 20,               // vh 単位 (画面高に対する%)
  color: '#ffffff',
  bgMode: 'transparent',      // 'transparent' | 'solid' | 'panel'
  bgColor: '#000000',
  bgOpacity: 0.6,
  position: 'center',         // 'center'|'top'|'bottom'|'tl'|'tr'|'bl'|'br'|'custom'
  posX: 50,                   // custom 時の % (中心基準)
  posY: 50,
  align: 'center',            // 'left'|'center'|'right' タイマーの揃え (桁数変化時のアンカー)
  shadow: true,
  outlineWidth: 0.05,         // 縁取りの太さ (em)。shadow=true のとき有効
  glow: false,
  glowColor: '#00e5ff',
};

// 永続化対象 (デザイン + 設定値)。running/remaining はランタイムのみ。
const PERSIST_KEYS = Object.keys(DEFAULT_STATE);

const state = Object.assign({}, DEFAULT_STATE);
// runtime-only
let running = false;
let remainingMs = state.durationMs; // anchor 残り
let anchorTime = monoNow();         // 単調時計の anchor

try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const k of PERSIST_KEYS) {
      if (loaded[k] !== undefined) state[k] = loaded[k];
    }
    remainingMs = state.durationMs;
  }
} catch (e) {
  console.warn('state.json load failed:', e && e.message);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out = {};
    for (const k of PERSIST_KEYS) out[k] = state[k];
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2)); }
    catch (e) { console.warn('state.json save failed:', e && e.message); }
  }, 500);
}

function currentRemaining() {
  if (!running) return remainingMs;
  return remainingMs - (monoNow() - anchorTime);
}

// クライアントに配る状態。remainingMs は「送信時点の残り」。
function publicState() {
  return {
    type: 'state',
    running,
    remainingMs: currentRemaining(),
    durationMs: state.durationMs,
    zeroMode: state.zeroMode,
    zeroText: state.zeroText,
    fontKey: state.fontKey,
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
    color: state.color,
    bgMode: state.bgMode,
    bgColor: state.bgColor,
    bgOpacity: state.bgOpacity,
    position: state.position,
    posX: state.posX,
    posY: state.posY,
    align: state.align,
    shadow: state.shadow,
    outlineWidth: state.outlineWidth,
    glow: state.glow,
    glowColor: state.glowColor,
  };
}

// --- WebSocket -------------------------------------------------------------
function serveStatic(res, file, type) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/' || p === '/director' || p === '/director.html') {
    serveStatic(res, 'director.html', 'text/html; charset=utf-8');
  } else if (p === '/overlay' || p === '/overlay.html') {
    serveStatic(res, 'overlay.html', 'text/html; charset=utf-8');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(payload); } catch (_) {}
    }
  });
}

function broadcastState() {
  broadcast(publicState());
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ディレクターからのコマンドを適用。状態が変わったら true。
function applyCommand(msg) {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.action) {
    case 'timer_set': {
      if (!isNum(msg.ms)) return false;
      const ms = clamp(Math.round(msg.ms), 0, 100 * 60 * 60 * 1000); // 0〜100h
      state.durationMs = ms;
      remainingMs = ms;
      anchorTime = monoNow();
      scheduleSave();
      return true;
    }
    case 'timer_start': {
      if (running) return false;
      remainingMs = currentRemaining();
      running = true;
      anchorTime = monoNow();
      return true;
    }
    case 'timer_pause': {
      if (!running) return false;
      remainingMs = currentRemaining();
      running = false;
      anchorTime = monoNow();
      return true;
    }
    case 'timer_toggle': {
      remainingMs = currentRemaining();
      running = !running;
      anchorTime = monoNow();
      return true;
    }
    case 'timer_reset': {
      running = false;
      remainingMs = state.durationMs;
      anchorTime = monoNow();
      return true;
    }
    case 'timer_adjust': {
      if (!isNum(msg.deltaMs)) return false;
      // 実行中でも停止中でも、現在残りに加算 (下限なし = マイナスも許容)
      remainingMs = currentRemaining() + Math.round(msg.deltaMs);
      anchorTime = monoNow();
      return true;
    }
    case 'timer_zero': {
      let changed = false;
      if (isStr(msg.mode) && ['blink', 'countup', 'text', 'static'].includes(msg.mode)) {
        state.zeroMode = msg.mode; changed = true;
      }
      if (isStr(msg.text)) { state.zeroText = msg.text.slice(0, 200); changed = true; }
      if (changed) scheduleSave();
      return changed;
    }
    case 'design': {
      let changed = false;
      const d = msg.data || {};
      if (isStr(d.fontKey))    { state.fontKey = d.fontKey; changed = true; }
      if (isStr(d.fontFamily)) { state.fontFamily = d.fontFamily; changed = true; }
      if (isNum(d.fontSize))   { state.fontSize = clamp(d.fontSize, 2, 80); changed = true; }
      if (isStr(d.color))      { state.color = d.color; changed = true; }
      if (isStr(d.bgMode) && ['transparent', 'solid', 'panel'].includes(d.bgMode)) { state.bgMode = d.bgMode; changed = true; }
      if (isStr(d.bgColor))    { state.bgColor = d.bgColor; changed = true; }
      if (isNum(d.bgOpacity))  { state.bgOpacity = clamp(d.bgOpacity, 0, 1); changed = true; }
      if (isStr(d.position) && ['center','top','bottom','tl','tr','bl','br','custom'].includes(d.position)) { state.position = d.position; changed = true; }
      if (isNum(d.posX))       { state.posX = clamp(d.posX, 0, 100); changed = true; }
      if (isNum(d.posY))       { state.posY = clamp(d.posY, 0, 100); changed = true; }
      if (isStr(d.align) && ['left','center','right'].includes(d.align)) { state.align = d.align; changed = true; }
      if (isBool(d.shadow))    { state.shadow = d.shadow; changed = true; }
      if (isNum(d.outlineWidth)) { state.outlineWidth = clamp(d.outlineWidth, 0, 0.3); changed = true; }
      if (isBool(d.glow))      { state.glow = d.glow; changed = true; }
      if (isStr(d.glowColor))  { state.glowColor = d.glowColor; changed = true; }
      if (changed) scheduleSave();
      return changed;
    }
    default:
      return false;
  }
}

wss.on('connection', (ws) => {
  // 接続直後に現在状態を送る
  try { ws.send(JSON.stringify(publicState())); } catch (_) {}

  ws.on('message', (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.action === '__ping') {
      try { ws.send(JSON.stringify({ type: '__pong', t: msg.t })); } catch (_) {}
      return;
    }
    if (applyCommand(msg)) broadcastState();
  });

  ws.on('error', () => {});
});

// 軽い定期再同期 (10秒)。遅延接続/ドリフト補正の保険。
// クライアントは同じ式で計算するので、再アンカーしても表示は飛ばない。
setInterval(() => {
  if (wss.clients.size > 0) broadcastState();
}, 10000);

// --- 起動 ------------------------------------------------------------------
function getLanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  Object.values(ifaces).forEach((list) => {
    (list || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    });
  });
  return ips;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ ポート ${PORT} は既に使用中です。前回のプロセスが残っているかも。`);
  } else {
    console.error('\n❌ サーバー起動エラー:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('⏱  カウントダウンオーバーレイ サーバー起動');
  const ips = getLanIPs();
  console.log('\n  ディレクター操作盤:');
  console.log(`    → http://localhost:${PORT}/`);
  ips.forEach((ip) => console.log(`    → http://${ip}:${PORT}/`));
  console.log('\n  OBS ブラウザソース:');
  console.log(`    → http://localhost:${PORT}/overlay`);
  ips.forEach((ip) => console.log(`    → http://${ip}:${PORT}/overlay`));
  console.log('');
});
