// Servidor Eldmor — mundo fixo para o Reinos de Eldmor.
// Não precisa instalar nada: só Node.js 18 ou mais novo. Rode com:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUB = path.resolve(process.env.PUB || path.join(__dirname, 'public'));
const BOSSES = 18;                       // quantidade de chefes no jogo
const BOSS_MIN = 8, BOSS_MAX = 16;       // minutos entre um chefe e outro (só um por vez)
const BOSS_LIFE = 12;                    // minutos até o chefe ir embora se ninguém matar
const EVENTS = ['blood', 'gold', 'xp', 'horde'];
const EV_MIN = 14, EV_MAX = 22, EV_LEN = 3; // minutos

const rand = (a, b) => a + Math.random() * (b - a);
const ADMIN_HASH = process.env.ADMIN_HASH || '5baf53334a1b7c526e4c1be9117271c600da5f8a52a6a9d44dc2ac5f0fde6ce1'; // nome secreto do Operador (hash)
const isOp = k => typeof k === 'string' && k.length < 64 && crypto.createHash('sha256').update('eldmor:' + k).digest('hex') === ADMIN_HASH;
const MIN = 60e3;

/* ---------- arquivos do jogo (pasta public) ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + clients.size); }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUB, u));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Servidor Eldmor ligado. ' + clients.size + ' jogador(es) online.'); }
    const ext = path.extname(f).toLowerCase();
    if (ext === '.html') data = Buffer.from(data.toString('utf8').replace('<head>', '<head><script>window.ELD_SAME=1</script>'));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' || u === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* ---------- WebSocket mínimo (sem bibliotecas) ---------- */
const clients = new Map(); let NEXT = 1;
function frame(str) {
  const p = Buffer.from(str); const n = p.length; let h;
  if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  h[0] = 0x81; return Buffer.concat([h, p]);
}
function send(c, o) { if (!c.dead) try { c.sock.write(frame(JSON.stringify(o))); } catch (e) { } }
function all(o, except) { const f = frame(JSON.stringify(o)); for (const c of clients.values()) if (c.joined && c !== except && !c.dead) try { c.sock.write(f); } catch (e) { } }

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: NEXT++, sock, buf: Buffer.alloc(0), joined: false, name: '', h: null, last: Date.now(), frag: [] };
  clients.set(c.id, c);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 1 << 20) return drop(c); parse(c); });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});
function parse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, fin = b0 & 128, masked = b1 & 128; let n = b1 & 127, o = 2;
    if (n === 126) { if (c.buf.length < 4) return; n = c.buf.readUInt16BE(2); o = 4; }
    else if (n === 127) { if (c.buf.length < 10) return; n = Number(c.buf.readBigUInt64BE(2)); o = 10; }
    if (n > 1 << 20) return drop(c);
    const mo = o; if (masked) o += 4; if (c.buf.length < o + n) return;
    const p = Buffer.from(c.buf.subarray(o, o + n)); if (masked) for (let i = 0; i < n; i++) p[i] ^= c.buf[mo + (i & 3)];
    c.buf = c.buf.subarray(o + n); c.last = Date.now();
    if (op === 8) return drop(c);
    if (op === 9) { const h = Buffer.from([0x8a, p.length]); try { c.sock.write(Buffer.concat([h, p])); } catch (e) { } continue; }
    if (op === 10) continue;
    if (op === 1 || op === 0) { c.frag.push(p); if (fin) { const s = Buffer.concat(c.frag).toString('utf8'); c.frag = []; let m; try { m = JSON.parse(s); } catch (e) { continue; } onMsg(c, m); } }
  }
}
function drop(c) {
  if (c.dead) return; c.dead = true; clients.delete(c.id); try { c.sock.destroy(); } catch (e) { }
  if (c.joined) { all({ t: 'pl', id: c.id }); console.log('saiu:', c.name, '| online:', online()); }
}
const online = () => [...clients.values()].filter(c => c.joined).length;
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);

/* ---------- mundo ---------- */
const W = { boss: null, nextBoss: Date.now() + (process.env.BOSS_FIRST ? +process.env.BOSS_FIRST * 1000 : rand(3, 6) * MIN), ev: null, nextEv: Date.now() + (process.env.EV_FIRST ? +process.env.EV_FIRST * 1000 : rand(6, 10) * MIN) };
function pub(c) { if (!c.h) return c.h; return c.op ? Object.assign({}, c.h, { lv: 0, op: 1 }) : c.h; }
function bossMsg() { const b = W.boss; return b ? { t: 'boss', bi: b.bi, hp: Math.ceil(b.hp), max: b.max } : null; }

function onMsg(c, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'join') {
    let name = clean(m.name) || 'Herói'; const taken = n => [...clients.values()].some(x => x.joined && x !== c && x.name.toLowerCase() === n.toLowerCase());
    let base = name, k = 2; while (taken(name)) name = (base.slice(0, 13) + ' ' + k++);
    if (isOp(m.k)) { c.op = true; name = 'Operador level 0'; }
    c.name = name; c.h = m.h || null; c.joined = true;
    send(c, { t: 'welcome', id: c.id, name, op: !!c.op, players: [...clients.values()].filter(x => x.joined && (!x.hide || x === c)).map(x => ({ id: x.id, name: x.name, h: pub(x) })), boss: bossMsg(), ev: W.ev ? { k: W.ev.k, rem: W.ev.end - Date.now() } : null });
    all({ t: 'pj', p: { id: c.id, name, h: pub(c) } }, c);
    console.log('entrou:', name, '| online:', online()); return;
  }
  if (!c.joined) return;
  if (m.t === 'p') { if (m.h && typeof m.h.x === 'number') c.h = m.h; return; }
  if (m.t === 'op' && c.op) {
    if (m.c === 'hide') { c.hide = !!m.v; if (c.hide) all({ t: 'pl', id: c.id }, c); else all({ t: 'pj', p: { id: c.id, name: c.name, h: pub(c) } }, c); }
    else if (m.c === 'boss' && m.bi >= 0 && m.bi < BOSSES) { if (W.boss) all({ t: 'bgone', bi: W.boss.bi }); W.boss = { bi: m.bi | 0, hp: 0, max: 0, who: new Set(), end: Date.now() + BOSS_LIFE * MIN, dirty: false, t: 0 }; all({ t: 'boss', bi: m.bi | 0 }); }
    else if (m.c === 'ev') { if (m.k && EVENTS.includes(m.k)) { W.ev = { k: m.k, end: Date.now() + EV_LEN * MIN }; all({ t: 'ev', k: m.k, rem: EV_LEN * MIN }); } else { W.ev = null; W.nextEv = Date.now() + rand(EV_MIN, EV_MAX) * MIN; all({ t: 'ev', k: null }); } }
    else if (m.c === 'smite') { const t = clients.get(m.id); if (t && t.joined && !t.op) send(t, { t: 'smite' }); }
    return;
  }
  if (m.t === 'bmax') { const b = W.boss; if (b && b.bi === m.bi && !b.max && m.max > 0 && m.max < 1e8) { const n = Math.max(1, online()); b.max = Math.round(m.max * (1 + 0.5 * (n - 1))); b.hp = b.max; all(bossMsg()); } return; }
  if (m.t === 'bhit') {
    const b = W.boss; if (!b || b.bi !== m.bi || !b.max) return; const d = Math.max(0, Math.min(+m.d || 0, b.max * (c.op ? 1 : 0.08)));
    b.hp -= d; b.who.add(c.id); b.dirty = true;
    if (b.hp <= 0) { const who = [...b.who]; all({ t: 'bdead', bi: b.bi, who, names: who.map(id => (clients.get(id) || {}).name).filter(Boolean) }); console.log('chefe derrotado:', b.bi); W.boss = null; W.nextBoss = Date.now() + rand(BOSS_MIN, BOSS_MAX) * MIN; }
    return;
  }
  if (m.t === 'chat') { const t = String(m.m || '').replace(/[<>]/g, '').trim().slice(0, 80); if (t && Date.now() - (c.chatT || 0) > 800) { c.chatT = Date.now(); all({ t: 'chat', n: c.name, m: t }, c); } return; }
}

setInterval(() => {
  const now = Date.now(), n = online();
  // posições de todos, 10 vezes por segundo
  if (n > 1) all({ t: 'ps', l: [...clients.values()].filter(c => c.joined && c.h && !c.hide).map(c => [c.id, pub(c)]) });
  // chefe raro, um por vez, igual para todos
  if (!W.boss && n > 0 && now >= W.nextBoss) {
    const bi = Math.floor(Math.random() * BOSSES); W.boss = { bi, hp: 0, max: 0, who: new Set(), end: now + BOSS_LIFE * MIN, dirty: false, t: 0 };
    all({ t: 'boss', bi }); console.log('chefe apareceu:', bi);
  }
  const b = W.boss;
  if (b) {
    if (now >= b.end) { all({ t: 'bgone', bi: b.bi }); W.boss = null; W.nextBoss = now + rand(BOSS_MIN, BOSS_MAX) * MIN; }
    else if (b.max) { b.t++; if (b.dirty || b.t % 10 === 0) { b.dirty = false; all({ t: 'bhp', bi: b.bi, hp: Math.ceil(b.hp), max: b.max }); } }
  }
  if (!n && b && !b.max) W.boss = null;
  // eventos do mundo
  if (W.ev && now >= W.ev.end) { W.ev = null; W.nextEv = now + rand(EV_MIN, EV_MAX) * MIN; all({ t: 'ev', k: null }); }
  if (!W.ev && n > 0 && now >= W.nextEv) { const k = EVENTS[Math.floor(Math.random() * EVENTS.length)]; W.ev = { k, end: now + EV_LEN * MIN }; all({ t: 'ev', k, rem: EV_LEN * MIN }); }
  // derruba conexões mortas
  for (const c of clients.values()) if (now - c.last > 45e3) drop(c);
}, 100);

server.listen(PORT, () => console.log('Servidor Eldmor ligado na porta ' + PORT));
