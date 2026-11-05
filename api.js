// Contas, saves, ranking, loja de diamantes e Mercado Pago do Reinos de Eldmor.
// Banco: DATABASE_URL (Postgres/Neon). Sem ele, guarda num arquivo local (some quando o Render reinicia).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MP_KEY = Object.keys(process.env).find(k => /^\s*MP_?ACCESS_?TOKEN\s*$/i.test(k)) || Object.keys(process.env).find(k => /mercado.?pago|^\s*MP_/i.test(k)) || '';
const MP_RAW = String(MP_KEY ? process.env[MP_KEY] : '').trim().replace(/^['"]|['"]$/g, '').replace(/^Bearer\s+/i, '');
const MP_TOKEN = /^(APP_USR|TEST)-/.test(MP_RAW) ? MP_RAW : '';
const MP_HINT = !MP_KEY ? 'sem variável' : !MP_RAW ? 'variável vazia' : !MP_TOKEN ? 'token em formato estranho' : /^TEST-/.test(MP_TOKEN) ? 'token de teste' : 'ok';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://eldmor-server.onrender.com').replace(/\/+$/, '');
const EARN_DAY = 150;      // diamantes que dá para ganhar jogando por dia (chefes, baús, missões)
const RENAME_COST = 300;
const PACKS = {            // pacotes de diamantes (R$)
  p1: { dia: 100, price: 4.90, n: '100 diamantes' },
  p2: { dia: 220, price: 9.90, n: '220 diamantes (+10%)' },
  p3: { dia: 600, price: 24.90, n: '600 diamantes (+20%)' },
  p4: { dia: 1300, price: 49.90, n: '1.300 diamantes (+30%)' },
  p5: { dia: 2800, price: 99.90, n: '2.800 diamantes (+40%)' },
};
// itens vendidos por diamantes: preço e se é permanente (fica na conta) ou consumível
const SHOP = {
  'boost:xp': { p: 80, kind: 'use' }, 'boost:gold': { p: 60, kind: 'use' },
  'chest:rare': { p: 150, kind: 'use', day: 3 }, 'bag': { p: 120, kind: 'count', max: 5 }, 'scroll5': { p: 30, kind: 'use' },
  'pal:neon': { p: 200, kind: 'perm' },
};
// peças de aparência que custam diamantes ("cos:classe.categoria.índice")
const COSP = {
  'warrior.hat.3': 15, 'archer.hat.3': 10, 'archer.hat.5': 20, 'mage.hat.3': 15, 'mage.hat.5': 10,
  'any.pet.3': 60, 'any.pet.4': 60, 'any.pet.10': 150, 'any.pet.11': 150, 'any.pet.12': 400, 'any.pet.13': 400,
  'any.pet.14': 900, 'any.pet.15': 900, 'any.pet.17': 2000, 'any.pet.18': 2000,
  'any.aura.4': 250, 'any.aura.5': 250, 'any.aura.6': 500, 'any.trail.3': 150, 'any.trail.4': 150, 'any.trail.5': 200,
};
for (const k in COSP) SHOP['cos:' + k] = { p: COSP[k], kind: 'perm' };

/* ---------- armazenamento ---------- */
let pg = null, pool = null;
const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
let MEM = { accs: [], toks: {}, pays: {}, next: 1 };
const db = {
  async init() {
    if (process.env.DATABASE_URL) {
      try {
        pg = require('pg');
        const url = String(process.env.DATABASE_URL).trim().replace(/^['"]|['"]$/g, '').replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
        pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 });
        await pool.query(`create table if not exists accounts(id serial primary key, name text not null, lname text unique not null, ph text not null, salt text not null,
          dia int not null default 0, owned jsonb not null default '{}', save jsonb, lvl int not null default 1, txp bigint not null default 0, cls text, op boolean not null default false,
          earn_day text, earned int not null default 0, created timestamptz default now(), updated timestamptz default now())`);
        await pool.query(`create table if not exists tokens(tok text primary key, acc int not null references accounts(id) on delete cascade, created timestamptz default now())`);
        await pool.query(`create table if not exists payments(id text primary key, acc int not null, dia int not null, status text, at timestamptz default now())`);
        console.log('Banco de dados Postgres conectado.'); return;
      } catch (e) { console.log('Não consegui usar o Postgres (' + e.message + '). Usando arquivo local.'); pool = null; }
    }
    try { MEM = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { }
    console.log('Sem DATABASE_URL: contas guardadas em arquivo local (somem quando o servidor reinicia).');
  },
  saveMem() { clearTimeout(db._t); db._t = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(MEM)); } catch (e) { } }, 1500); },
  async byName(ln) { if (pool) return (await pool.query('select * from accounts where lname=$1', [ln])).rows[0]; return MEM.accs.find(a => a.lname === ln); },
  async byId(id) { if (pool) return (await pool.query('select * from accounts where id=$1', [id])).rows[0]; return MEM.accs.find(a => a.id === id); },
  async create(a) {
    if (pool) return (await pool.query('insert into accounts(name,lname,ph,salt,op) values($1,$2,$3,$4,$5) returning *', [a.name, a.lname, a.ph, a.salt, !!a.op])).rows[0];
    const r = Object.assign({ id: MEM.next++, dia: 0, owned: {}, save: null, lvl: 1, txp: 0, cls: null, earned: 0, earn_day: null }, a); MEM.accs.push(r); db.saveMem(); return r;
  },
  async set(id, f) {
    if (pool) { const ks = Object.keys(f); if (!ks.length) return; const q = 'update accounts set ' + ks.map((k, i) => k + '=$' + (i + 2)).join(',') + ',updated=now() where id=$1'; await pool.query(q, [id, ...ks.map(k => (k === 'owned' || k === 'save') && f[k] !== null ? JSON.stringify(f[k]) : f[k])]); return; }
    const a = MEM.accs.find(x => x.id === id); if (a) Object.assign(a, f); db.saveMem();
  },
  async addTok(id) { const t = crypto.randomBytes(24).toString('hex'); if (pool) { await pool.query('insert into tokens(tok,acc) values($1,$2)', [t, id]); await pool.query('delete from tokens where acc=$1 and tok not in (select tok from tokens where acc=$1 order by created desc limit 8)', [id]); } else { MEM.toks[t] = id; db.saveMem(); } return t; },
  async tokAcc(t) { if (!t || typeof t !== 'string') return null; if (pool) { const r = (await pool.query('select acc from tokens where tok=$1', [t])).rows[0]; return r ? db.byId(r.acc) : null; } const id = MEM.toks[t]; return id ? db.byId(id) : null; },
  async dropToks(id) { if (pool) await pool.query('delete from tokens where acc=$1', [id]); else { for (const k in MEM.toks) if (MEM.toks[k] === id) delete MEM.toks[k]; db.saveMem(); } },
  async rank(n) { if (pool) return (await pool.query('select name,lvl,txp,cls from accounts where op=false and lvl>1 order by lvl desc, txp desc, id asc limit $1', [n])).rows; return MEM.accs.filter(a => !a.op && a.lvl > 1).sort((a, b) => b.lvl - a.lvl || b.txp - a.txp || a.id - b.id).slice(0, n).map(a => ({ name: a.name, lvl: a.lvl, txp: a.txp, cls: a.cls })); },
  async payNew(pid, acc, dia, status) { if (pool) { const r = await pool.query('insert into payments(id,acc,dia,status) values($1,$2,$3,$4) on conflict (id) do nothing returning id', [pid, acc, dia, status]); return r.rowCount > 0; } if (MEM.pays[pid]) return false; MEM.pays[pid] = { acc, dia, status, at: Date.now() }; db.saveMem(); return true; },
  // soma diamantes de forma segura (sem corrida entre duas compras)
  async addDia(id, n) { if (pool) return (await pool.query('update accounts set dia=dia+$2,updated=now() where id=$1 returning dia', [id, n])).rows[0].dia; const a = MEM.accs.find(x => x.id === id); a.dia += n; db.saveMem(); return a.dia; },
  async spendDia(id, n) { if (pool) { const r = await pool.query('update accounts set dia=dia-$2,updated=now() where id=$1 and dia>=$2 returning dia', [id, n]); return r.rowCount ? r.rows[0].dia : null; } const a = MEM.accs.find(x => x.id === id); if (a.dia < n) return null; a.dia -= n; db.saveMem(); return a.dia; },
};

/* ---------- utilidades ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const cleanName = s => String(s || '').replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const validName = n => n.length >= 3 && /^[\p{L}\p{N} _.\-@]+$/u.test(n);
const today = () => new Date().toISOString().slice(0, 10);
let isOpName = () => false, notify = () => { };
function pubAcc(a) { return { id: a.id, name: a.op ? 'Operador level 0' : a.name, realName: a.name, dia: a.dia, owned: a.owned || {}, op: !!a.op, lvl: a.lvl }; }
function body(req) { return new Promise(res => { let d = ''; req.on('data', c => { d += c; if (d.length > 600000) req.destroy(); }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { res({}); } }); }); }
function send(res, code, o) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); }
const auth = req => db.tokAcc(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
const hits = new Map();
function limited(req, key, n, ms) { const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0]; const k = key + ip, now = Date.now(); const h = (hits.get(k) || []).filter(t => now - t < ms); h.push(now); hits.set(k, h); return h.length > n; }

/* ---------- Mercado Pago ---------- */
async function mpFetch(p, opt) { const r = await fetch('https://api.mercadopago.com' + p, Object.assign({}, opt, { headers: Object.assign({ authorization: 'Bearer ' + MP_TOKEN, 'content-type': 'application/json' }, (opt && opt.headers) || {}) })); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t }; } if (!r.ok) throw new Error('Mercado Pago ' + r.status + ': ' + (j.message || t).slice(0, 200)); return j; }
async function mpCheck(pid) {
  if (!MP_TOKEN || !/^\d{3,20}$/.test(String(pid))) return;
  const p = await mpFetch('/v1/payments/' + pid);
  if (p.status !== 'approved') return;
  const [accS, pack] = String(p.external_reference || '').split(':'); const acc = +accS, pk = PACKS[pack];
  if (!acc || !pk) return;
  if (Math.abs((p.transaction_amount || 0) - pk.price) > 0.01) { console.log('valor diferente no pagamento', pid); return; }
  if (!(await db.payNew(String(pid), acc, pk.dia, p.status))) return;
  const dia = await db.addDia(acc, pk.dia); console.log('pagamento aprovado', pid, 'conta', acc, '+' + pk.dia);
  notify(acc, { t: 'dia', dia, add: pk.dia, why: 'Compra aprovada: +' + pk.dia + ' diamantes' });
}

/* ---------- rotas ---------- */
async function handle(req, res, u) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (u === '/api/info') return send(res, 200, { ok: true, db: !!pool, pay: !!MP_TOKEN, payHint: MP_HINT, mpKey: MP_KEY ? JSON.stringify(MP_KEY) : '', packs: PACKS, shop: SHOP, rename: RENAME_COST, earnDay: EARN_DAY });
    if (u === '/api/register' && req.method === 'POST') {
      if (limited(req, 'reg', +(process.env.REG_LIMIT || 6), 3600e3)) return send(res, 429, { err: 'Muitas contas criadas daqui. Tente mais tarde.' });
      const b = await body(req); const name = cleanName(b.name), pw = String(b.pass || '');
      if (!validName(name)) return send(res, 400, { err: 'O nome precisa ter de 3 a 16 letras ou números.' });
      if (pw.length < 4 || pw.length > 64) return send(res, 400, { err: 'A senha precisa ter pelo menos 4 caracteres.' });
      const op = isOpName(name);
      if (!op && /operador/i.test(name)) return send(res, 400, { err: 'Esse nome é reservado.' });
      const ln = name.toLowerCase(); if (await db.byName(ln)) return send(res, 409, { err: 'Esse nome já está em uso. Escolha outro.' });
      const salt = crypto.randomBytes(12).toString('hex'); const a = await db.create({ name, lname: ln, ph: hashPw(pw, salt), salt, op });
      return send(res, 200, { tok: await db.addTok(a.id), acc: pubAcc(a), save: null });
    }
    if (u === '/api/login' && req.method === 'POST') {
      if (limited(req, 'log', 20, 600e3)) return send(res, 429, { err: 'Muitas tentativas. Espere alguns minutos.' });
      const b = await body(req); const a = await db.byName(cleanName(b.name).toLowerCase());
      if (!a || hashPw(b.pass || '', a.salt) !== a.ph) return send(res, 401, { err: 'Nome ou senha errados.' });
      return send(res, 200, { tok: await db.addTok(a.id), acc: pubAcc(a), save: a.save || null });
    }
    if (u === '/api/rank') { const l = await db.rank(50); return send(res, 200, { list: l.map((x, i) => ({ pos: i + 1, name: x.name, lvl: x.lvl, cls: x.cls })) }); }
    if (u === '/api/mp/webhook') {
      const b = req.method === 'POST' ? await body(req) : {}; const q = new URL(req.url, 'http://x').searchParams;
      const pid = (b.data && b.data.id) || q.get('data.id') || (q.get('topic') === 'payment' ? q.get('id') : null);
      if (pid) mpCheck(pid).catch(e => console.log('webhook:', e.message));
      return send(res, 200, { ok: true });
    }
    if (u === '/api/mp/return') {
      const q = new URL(req.url, 'http://x').searchParams; const pid = q.get('payment_id'); if (pid) mpCheck(pid).catch(() => { });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;background:#141a2c;color:#fff;text-align:center;padding:40px"><h2>${q.get('status') === 'approved' || q.get('collection_status') === 'approved' ? 'Pagamento aprovado!' : 'Pagamento em andamento'}</h2><p>Os diamantes aparecem no jogo em instantes. Pode fechar esta página e voltar para o Reinos de Eldmor.</p></body>`);
    }
    const a = await auth(req); if (!a) return send(res, 401, { err: 'Entre na sua conta de novo.' });
    if (u === '/api/me') return send(res, 200, { acc: pubAcc(a), save: a.save || null });
    if (u === '/api/save' && req.method === 'POST') {
      const b = await body(req); const s = b.save; if (!s || typeof s !== 'object') return send(res, 400, { err: 'save inválido' });
      const lvl = Math.max(1, Math.min(1000, s.lvl | 0)), txp = Math.max(0, Math.min(9e15, +s.txp || 0));
      delete s.dia; await db.set(a.id, { save: s, lvl, txp, cls: String(s.cls || '').slice(0, 10) }); return send(res, 200, { ok: true, dia: a.dia });
    }
    if (u === '/api/earn' && req.method === 'POST') {
      const b = await body(req); let n = Math.max(0, Math.min(60, b.n | 0)); const d = today(); let earned = a.earn_day === d ? a.earned : 0;
      n = Math.min(n, EARN_DAY - earned); if (n > 0) { earned += n; await db.set(a.id, { earn_day: d, earned }); const dia = await db.addDia(a.id, n); return send(res, 200, { dia, got: n }); }
      return send(res, 200, { dia: a.dia, got: 0, cap: true });
    }
    if (u === '/api/spend' && req.method === 'POST') {
      const b = await body(req); const key = String(b.item || ''); const it = SHOP[key]; if (!it) return send(res, 400, { err: 'Item desconhecido.' });
      const owned = a.owned || {}; const d = today();
      if (it.kind === 'perm' && owned[key]) return send(res, 400, { err: 'Você já tem este item.' });
      if (it.kind === 'count' && (owned[key] || 0) >= it.max) return send(res, 400, { err: 'Você já comprou o máximo deste item.' });
      if (it.day) { const k2 = key + '@' + d; if ((owned[k2] || 0) >= it.day) return send(res, 400, { err: 'Limite de hoje atingido. Volte amanhã.' }); }
      const dia = await db.spendDia(a.id, it.p); if (dia === null) return send(res, 400, { err: 'Diamantes insuficientes.', need: it.p });
      if (it.kind === 'perm') owned[key] = 1; else if (it.kind === 'count') owned[key] = (owned[key] || 0) + 1;
      if (it.day) { for (const k in owned) if (k.includes('@') && !k.endsWith(d)) delete owned[k]; owned[key + '@' + d] = (owned[key + '@' + d] || 0) + 1; }
      await db.set(a.id, { owned }); return send(res, 200, { dia, owned, item: key });
    }
    if (u === '/api/rename' && req.method === 'POST') {
      const b = await body(req); const name = cleanName(b.name); if (!validName(name)) return send(res, 400, { err: 'O nome precisa ter de 3 a 16 letras ou números.' });
      if (/operador/i.test(name) || isOpName(name)) return send(res, 400, { err: 'Esse nome é reservado.' });
      const ln = name.toLowerCase(); const other = await db.byName(ln); if (other && other.id !== a.id) return send(res, 409, { err: 'Esse nome já está em uso.' });
      const owned = a.owned || {}; let dia = a.dia;
      if (owned.freeRename) { delete owned.freeRename; } else { dia = await db.spendDia(a.id, RENAME_COST); if (dia === null) return send(res, 400, { err: 'Trocar de nome custa ' + RENAME_COST + ' diamantes.' }); }
      await db.set(a.id, { name, lname: ln, owned }); return send(res, 200, { name, dia, owned });
    }
    if (u === '/api/reset' && req.method === 'POST') {
      const b = await body(req); if (hashPw(b.pass || '', a.salt) !== a.ph) return send(res, 401, { err: 'Senha errada.' });
      const owned = a.owned || {}; owned.freeRename = 1; await db.set(a.id, { save: null, lvl: 1, txp: 0, owned }); return send(res, 200, { ok: true, owned });
    }
    if (u === '/api/buy' && req.method === 'POST') {
      const b = await body(req); const pk = PACKS[b.pack]; if (!pk) return send(res, 400, { err: 'Pacote inválido.' });
      if (!MP_TOKEN) return send(res, 503, { err: 'As compras ainda não foram ativadas neste servidor.' });
      const pref = await mpFetch('/checkout/preferences', { method: 'POST', body: JSON.stringify({
        items: [{ id: b.pack, title: 'Reinos de Eldmor - ' + pk.n, quantity: 1, currency_id: 'BRL', unit_price: pk.price }],
        external_reference: a.id + ':' + b.pack, notification_url: PUBLIC_URL + '/api/mp/webhook',
        back_urls: { success: PUBLIC_URL + '/api/mp/return', pending: PUBLIC_URL + '/api/mp/return', failure: PUBLIC_URL + '/api/mp/return' }, auto_return: 'approved',
        statement_descriptor: 'ELDMOR', metadata: { acc: a.id, pack: b.pack } }) });
      return send(res, 200, { url: pref.init_point });
    }
    if (u === '/api/logout' && req.method === 'POST') { await db.dropToks(a.id); return send(res, 200, { ok: true }); }
    return send(res, 404, { err: 'rota desconhecida' });
  } catch (e) { console.log('api erro', u, e.message); return send(res, 500, { err: 'Erro no servidor. Tente de novo.' }); }
}
module.exports = { db, handle, setHooks(h) { if (h.isOpName) isOpName = h.isOpName; if (h.notify) notify = h.notify; }, pubAcc };
