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
  mes: { dia: 1000, price: 19.90, n: 'Pacote do Mês: 1.000 diamantes', site: true },   // só no site, 1 vez por mês
};
/* bônus de quem compra pelo site (Mercado Pago): não vale para compras feitas pela Google Play */
const SITE = { bonus: 0.20, ptsPerReal: 10, perks: ['title:apoiador', 'cos:any.aura.10'] };
const PTSHOP = { 'pts:dia100': { pts: 600, n: '100 diamantes', dia: 100 }, 'cos:any.trail.6': { pts: 400 }, 'frame:5': { pts: 400 }, 'ev:capa_estelar': { pts: 500 },
  'mount:cavalo': { pts: 900 }, 'mount:unic': { pts: 1800 }, 'cos:any.pet.19': { pts: 2500 } };
const brtMonth = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7);
/* Google Play: o servidor confirma cada compra direto com o Google antes de entregar */
const GPLAY_PKG = (process.env.GPLAY_PKG || 'com.wendrew.reinosdeeldmor').trim();
let GPLAY_SA = null; try { if (process.env.GPLAY_SA) GPLAY_SA = JSON.parse(process.env.GPLAY_SA.trim().startsWith('{') ? process.env.GPLAY_SA : Buffer.from(process.env.GPLAY_SA, 'base64').toString()); } catch (e) { console.log('GPLAY_SA inválido'); }
let GTOK = { t: '', exp: 0 };
async function gToken() {
  if (GTOK.t && Date.now() < GTOK.exp) return GTOK.t;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url'); const now = Math.floor(Date.now() / 1000);
  const data = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: GPLAY_SA.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), GPLAY_SA.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + data + '.' + sig });
  const j = await r.json(); if (!j.access_token) throw new Error('Google recusou a conta de serviço: ' + (j.error_description || j.error || r.status));
  GTOK = { t: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 }; return GTOK.t;
}
async function gplay(path, method) { const t = await gToken(); const r = await fetch('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + GPLAY_PKG + path, { method: method || 'GET', headers: { authorization: 'Bearer ' + t } });
  const tx = await r.text(); let j = {}; try { j = tx ? JSON.parse(tx) : {}; } catch (e) { } if (!r.ok) throw new Error('Google Play ' + r.status + ': ' + ((j.error && j.error.message) || tx).slice(0, 160)); return j; }
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
let MEM = { accs: [], toks: {}, pays: {}, next: 1, sup: [] };
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
        await pool.query(`create table if not exists support(id serial primary key, acc int, name text, contact text, msg text not null, done boolean not null default false, at timestamptz default now())`);
        await pool.query(`create table if not exists payments(id text primary key, acc int not null, dia int not null, status text, at timestamptz default now())`);
        console.log('Banco de dados Postgres conectado.'); await G.init(); await S3.init(); return;
      } catch (e) { console.log('Não consegui usar o Postgres (' + e.message + '). Usando arquivo local.'); pool = null; }
    }
    try { MEM = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { }
    await G.init(); await S3.init();
    console.log('Sem DATABASE_URL: contas guardadas em arquivo local (somem quando o servidor reinicia).');
  },
  saveMem() { clearTimeout(db._t); db._t = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(MEM)); } catch (e) { } }, 1500); },
  async byName(ln) { if (pool) return (await pool.query('select * from accounts where lname=$1', [ln])).rows[0]; return MEM.accs.find(a => a.lname === ln); },
  async byId(id) { if (pool) return (await pool.query('select * from accounts where id=$1', [id])).rows[0]; return MEM.accs.find(a => a.id === id); },
  async create(a) {
    if (pool) return (await pool.query('insert into accounts(name,lname,ph,salt,op) values($1,$2,$3,$4,$5) returning *', [a.name, a.lname, a.ph, a.salt, !!a.op])).rows[0];
    const r = Object.assign({ id: MEM.next++, created: new Date().toISOString(), dia: 0, owned: {}, save: null, lvl: 1, txp: 0, cls: null, earned: 0, earn_day: null }, a); MEM.accs.push(r); db.saveMem(); return r;
  },
  async set(id, f) {
    if (pool) { const ks = Object.keys(f); if (!ks.length) return; const q = 'update accounts set ' + ks.map((k, i) => k + '=$' + (i + 2)).join(',') + ',updated=now() where id=$1'; await pool.query(q, [id, ...ks.map(k => (k === 'owned' || k === 'save') && f[k] !== null ? JSON.stringify(f[k]) : f[k])]); return; }
    const a = MEM.accs.find(x => x.id === id); if (a) Object.assign(a, f, { updated: new Date().toISOString() }); db.saveMem();
  },
  async addTok(id) { const t = crypto.randomBytes(24).toString('hex'); if (pool) { await pool.query('insert into tokens(tok,acc) values($1,$2)', [t, id]); await pool.query('delete from tokens where acc=$1 and tok not in (select tok from tokens where acc=$1 order by created desc limit 8)', [id]); } else { MEM.toks[t] = id; db.saveMem(); } return t; },
  async tokAcc(t) { if (!t || typeof t !== 'string') return null; if (pool) { const r = (await pool.query('select acc from tokens where tok=$1', [t])).rows[0]; return r ? db.byId(r.acc) : null; } const id = MEM.toks[t]; return id ? db.byId(id) : null; },
  async dropToks(id) { if (pool) await pool.query('delete from tokens where acc=$1', [id]); else { for (const k in MEM.toks) if (MEM.toks[k] === id) delete MEM.toks[k]; db.saveMem(); } },
  async rank(n) { if (pool) return (await pool.query('select name,lvl,txp,cls,owned->>\'title\' as title from accounts where op=false and lvl>1 order by lvl desc, txp desc, id asc limit $1', [n])).rows; return MEM.accs.filter(a => !a.op && a.lvl > 1).sort((a, b) => b.lvl - a.lvl || b.txp - a.txp || a.id - b.id).slice(0, n).map(a => ({ name: a.name, lvl: a.lvl, txp: a.txp, cls: a.cls, title: (a.owned || {}).title || null })); },
  async hasSitePay(acc) { if (pool) return (await pool.query("select 1 from payments where acc=$1 and id not like 'gp:%' limit 1", [acc])).rowCount > 0; return Object.entries(MEM.pays || {}).some(([k, v]) => v.acc === acc && !k.startsWith('gp:')); },
  async payNew(pid, acc, dia, status) { if (pool) { const r = await pool.query('insert into payments(id,acc,dia,status) values($1,$2,$3,$4) on conflict (id) do nothing returning id', [pid, acc, dia, status]); return r.rowCount > 0; } if (MEM.pays[pid]) return false; MEM.pays[pid] = { acc, dia, status, at: Date.now() }; db.saveMem(); return true; },
  async supAdd(o) { if (pool) { await pool.query('insert into support(acc,name,contact,msg) values($1,$2,$3,$4)', [o.acc, o.name, o.contact, o.msg]); return; } MEM.sup = MEM.sup || []; MEM.sup.push(Object.assign({ id: Date.now(), done: false, at: new Date().toISOString() }, o)); db.saveMem(); },
  async supList() { if (pool) return (await pool.query('select id,acc,name,contact,msg,done,at from support order by done asc, at desc limit 100')).rows; return (MEM.sup || []).slice().reverse().slice(0, 100); },
  async supOpen() { if (pool) return +(await pool.query('select count(*)::int n from support where done=false')).rows[0].n; return (MEM.sup || []).filter(m => !m.done).length; },
  async opIds() { if (pool) return (await pool.query('select id from accounts where op=true')).rows.map(r => r.id); return MEM.accs.filter(a => a.op).map(a => a.id); },
  async supDone(id) { if (pool) await pool.query('update support set done=true where id=$1', [id]); else { const x = (MEM.sup || []).find(m => m.id === id); if (x) x.done = true; db.saveMem(); } },
  async delAcc(id) { if (pool) { await pool.query('delete from tokens where acc=$1', [id]); await pool.query('delete from accounts where id=$1', [id]); return; } MEM.accs = MEM.accs.filter(a => a.id !== id); for (const k in MEM.toks) if (MEM.toks[k] === id) delete MEM.toks[k]; db.saveMem(); },
  // soma diamantes de forma segura (sem corrida entre duas compras)
  async addDia(id, n) { if (pool) return (await pool.query('update accounts set dia=dia+$2,updated=now() where id=$1 returning dia', [id, n])).rows[0].dia; const a = MEM.accs.find(x => x.id === id); a.dia += n; db.saveMem(); return a.dia; },
  async spendDia(id, n) { if (pool) { const r = await pool.query('update accounts set dia=dia-$2,updated=now() where id=$1 and dia>=$2 returning dia', [id, n]); return r.rowCount ? r.rows[0].dia : null; } const a = MEM.accs.find(x => x.id === id); if (a.dia < n) return null; a.dia -= n; db.saveMem(); return a.dia; },
};

/* ---------- utilidades ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const cleanName = s => String(s || '').replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const validName = n => n.length >= 3 && /^[\p{L}\p{N} _.\-@]+$/u.test(n);
const today = () => new Date().toISOString().slice(0, 10);
let isOpName = () => false, notify = () => { }, onlineFn = () => [];
function pubAcc(a) { return { id: a.id, name: a.op ? 'Operador level 0' : a.name, realName: a.name, dia: a.dia, owned: a.owned || {}, op: !!a.op, lvl: a.lvl, guild: a.guild || null }; }
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
  return withLock(acc, async () => {
    const first = !(await db.hasSitePay(acc));
    const bonus = pk.site ? 0 : Math.round(pk.dia * SITE.bonus), dbl = first && !pk.site ? pk.dia : 0, add = pk.dia + bonus + dbl;
    if (!(await db.payNew(String(pid), acc, add, p.status))) return;
    const dia = await db.addDia(acc, add);
    const f = await db.byId(acc); const owned = f.owned || {}; const pts = Math.round(pk.price * SITE.ptsPerReal); owned.pts = (owned.pts || 0) + pts; const newPerks = SITE.perks.filter(k => !owned[k]); for (const k of SITE.perks) owned[k] = 1;
    if (pk.site) owned['mes@' + brtMonth()] = 1; if (!owned.title) owned.title = 'title:apoiador';
    await db.set(acc, { owned }); await S3.txAdd(acc, 'site', pk.n + (bonus ? ' +' + bonus + ' bônus' : '') + (dbl ? ' +' + dbl + ' 1ª compra' : ''), 0, null, 'mp-' + pid);
    console.log('pagamento aprovado', pid, 'conta', acc, '+' + add);
    notify(acc, { t: 'dia', dia, add, owned, why: 'Compra aprovada: +' + add + ' diamantes' + (bonus ? ' (com +' + bonus + ' de bônus do site' + (dbl ? ' e +' + dbl + ' da 1ª compra em dobro' : '') + ')' : '') + ' e +' + pts + ' pontos' + (newPerks.length ? '. Você ganhou o selo e a Aura do Apoiador!' : '') });
  });
}


/* ================= guildas, guerra de guildas e códigos de resgate ================= */
const GUILD_COST = 250, GUILD_MAX = 30, GUILD_RANK_MIN = 3;
const WAR_PTS_MAX = 4000;           // pontos que um jogador pode somar numa guerra
const WAR_PRIZE = [150, 80, 40];     // diamantes para cada membro do 1º, 2º e 3º lugar
const shaCode = c => crypto.createHash('sha256').update('eldcode:' + c).digest('hex');
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// códigos prontos (guardados só como hash, porque o código-fonte é público)
const SEED_CODES = require('./codes_seed.json');
const G = {
  async init() {
    if (pool) {
      await pool.query('alter table accounts add column if not exists guild int');
      await pool.query(`create table if not exists guilds(id serial primary key, name text not null, lname text unique not null, tag text not null, leader int not null, descr text not null default '', open boolean not null default true, reqs jsonb not null default '[]', wins int not null default 0, created timestamptz default now())`);
      await pool.query(`create table if not exists codes(h text primary key, plain text, reward jsonb not null, max int not null default 1, uses int not null default 0, until timestamptz, note text, created timestamptz default now())`);
      await pool.query(`create table if not exists code_uses(h text not null, acc int not null, at timestamptz default now(), primary key(h, acc))`);
      await pool.query(`create table if not exists kv(k text primary key, v jsonb)`);
      await pool.query(`create table if not exists war_pts(war int not null, acc int not null, guild int not null, pts int not null default 0, primary key(war, acc))`);
      for (const s of SEED_CODES) await pool.query('insert into codes(h,reward,max,until,note) values($1,$2,$3,$4,$5) on conflict (h) do nothing', [s.h, JSON.stringify(s.reward), s.max, s.until || null, s.note]);
    } else {
      MEM.guilds = MEM.guilds || []; MEM.codes = MEM.codes || {}; MEM.cuses = MEM.cuses || {}; MEM.kv = MEM.kv || {}; MEM.wpts = MEM.wpts || {}; MEM.gnext = MEM.gnext || 1;
      for (const s of SEED_CODES) if (!MEM.codes[s.h]) MEM.codes[s.h] = { h: s.h, reward: s.reward, max: s.max, uses: 0, until: s.until || null, note: s.note };
      db.saveMem();
    }
  },
  async q(sql, args) { return (await pool.query(sql, args)).rows; },
  async kvGet(k) { if (pool) { const r = await G.q('select v from kv where k=$1', [k]); return r[0] ? r[0].v : null; } return MEM.kv[k] || null; },
  async kvSet(k, v) { if (pool) { await pool.query('insert into kv(k,v) values($1,$2) on conflict (k) do update set v=$2', [k, JSON.stringify(v)]); return; } MEM.kv[k] = v; db.saveMem(); },
  async gById(id) { if (!id) return null; if (pool) return (await G.q('select * from guilds where id=$1', [id]))[0]; return MEM.guilds.find(g => g.id === id); },
  async gByName(ln) { if (pool) return (await G.q('select * from guilds where lname=$1', [ln]))[0]; return MEM.guilds.find(g => g.lname === ln); },
  async gCreate(o) { if (pool) return (await G.q('insert into guilds(name,lname,tag,leader,descr) values($1,$2,$3,$4,$5) returning *', [o.name, o.lname, o.tag, o.leader, o.descr || '']))[0]; const g = Object.assign({ id: MEM.gnext++, open: true, reqs: [], wins: 0, descr: '' }, o); MEM.guilds.push(g); db.saveMem(); return g; },
  async gSet(id, f) { if (pool) { const ks = Object.keys(f); await pool.query('update guilds set ' + ks.map((k, i) => k + '=$' + (i + 2)).join(',') + ' where id=$1', [id, ...ks.map(k => k === 'reqs' ? JSON.stringify(f[k]) : f[k])]); return; } const g = MEM.guilds.find(x => x.id === id); if (g) Object.assign(g, f); db.saveMem(); },
  async gDel(id) { if (pool) { await pool.query('update accounts set guild=null where guild=$1', [id]); await pool.query('delete from guilds where id=$1', [id]); return; } for (const a of MEM.accs) if (a.guild === id) a.guild = null; MEM.guilds = MEM.guilds.filter(g => g.id !== id); db.saveMem(); },
  async members(id) { if (pool) return G.q('select id,name,lvl,cls,op from accounts where guild=$1 order by lvl desc, id asc', [id]); return MEM.accs.filter(a => a.guild === id).sort((a, b) => b.lvl - a.lvl || a.id - b.id).map(a => ({ id: a.id, name: a.name, lvl: a.lvl, cls: a.cls, op: a.op })); },
  async stats() { // todas as guildas com quantidade de membros e média de nível
    if (pool) return G.q(`select g.id,g.name,g.tag,g.open,g.wins,g.descr,count(a.id)::int as n,coalesce(round(avg(a.lvl)),0)::int as avg from guilds g left join accounts a on a.guild=g.id group by g.id order by avg desc, n desc, g.id asc`);
    return MEM.guilds.map(g => { const m = MEM.accs.filter(a => a.guild === g.id); return { id: g.id, name: g.name, tag: g.tag, open: g.open, wins: g.wins, descr: g.descr, n: m.length, avg: m.length ? Math.round(m.reduce((s, a) => s + a.lvl, 0) / m.length) : 0 }; }).sort((a, b) => b.avg - a.avg || b.n - a.n || a.id - b.id);
  },
  async count(id) { if (pool) return (await G.q('select count(*)::int as n from accounts where guild=$1', [id]))[0].n; return MEM.accs.filter(a => a.guild === id).length; },
  /* guerra */
  async war() { let w = await G.kvGet('war'); if (w && w.on && Date.now() > w.ends) w = await G.warEnd(w); return w; },
  async warBoard(w) { if (!w) return []; if (pool) return G.q('select g.id,g.name,g.tag,sum(p.pts)::int as pts,count(p.acc)::int as n from war_pts p join guilds g on g.id=p.guild where p.war=$1 group by g.id order by pts desc limit 20', [w.id]);
    const t = {}; for (const k in MEM.wpts) { const p = MEM.wpts[k]; if (p.war !== w.id) continue; const g = MEM.guilds.find(x => x.id === p.guild); if (!g) continue; t[g.id] = t[g.id] || { id: g.id, name: g.name, tag: g.tag, pts: 0, n: 0 }; t[g.id].pts += p.pts; t[g.id].n++; } return Object.values(t).sort((a, b) => b.pts - a.pts).slice(0, 20); },
  async warEnd(w) {
    if (!w || !w.on) return w; w.on = false; w.ended = Date.now(); await G.kvSet('war', w);
    const board = await G.warBoard(w); w.result = board.slice(0, 3).map((g, i) => ({ pos: i + 1, id: g.id, name: g.name, tag: g.tag, pts: g.pts }));
    for (let i = 0; i < w.result.length; i++) {
      const g = w.result[i]; const mem = await G.members(g.id);
      if (i === 0) { const gg = await G.gById(g.id); if (gg) await G.gSet(g.id, { wins: (gg.wins || 0) + 1 }); }
      for (const m of mem) {
        const dia = await db.addDia(m.id, WAR_PRIZE[i]);
        if (i === 0) { const a = await db.byId(m.id); const owned = a.owned || {}; owned['cos:any.aura.7'] = 1; await db.set(m.id, { owned }); }
        notify(m.id, { t: 'dia', dia, add: WAR_PRIZE[i], why: `Guerra de Guildas: ${g.name} ficou em ${i + 1}º lugar! +${WAR_PRIZE[i]} diamantes${i === 0 ? ' e a Aura de Campeão' : ''}` });
      }
    }
    await G.kvSet('war', w); console.log('guerra encerrada', JSON.stringify(w.result)); return w;
  },
  /* códigos */
  async codeGet(h) { if (pool) return (await G.q('select * from codes where h=$1', [h]))[0]; return MEM.codes[h]; },
  async codeAdd(o) { if (pool) { await pool.query('insert into codes(h,plain,reward,max,until,note) values($1,$2,$3,$4,$5,$6)', [o.h, o.plain, JSON.stringify(o.reward), o.max, o.until, o.note]); return; } MEM.codes[o.h] = Object.assign({ uses: 0, created: new Date().toISOString() }, o); db.saveMem(); },
  async codeList() { if (pool) return G.q('select plain,reward,max,uses,until,note,created from codes order by created desc limit 200'); return Object.values(MEM.codes).reverse().slice(0, 200); },
  async codeUse(h, acc) { // marca o uso; devolve false se já usou ou acabou
    if (pool) {
      const ins = await pool.query('insert into code_uses(h,acc) values($1,$2) on conflict do nothing returning h', [h, acc]); if (!ins.rowCount) return 'used';
      const up = await pool.query('update codes set uses=uses+1 where h=$1 and uses<max returning uses', [h]); if (!up.rowCount) { await pool.query('delete from code_uses where h=$1 and acc=$2', [h, acc]); return 'out'; } return 'ok';
    }
    const k = h + ':' + acc; if (MEM.cuses[k]) return 'used'; const c = MEM.codes[h]; if (c.uses >= c.max) return 'out'; MEM.cuses[k] = 1; c.uses++; db.saveMem(); return 'ok';
  },
};
const okGuildName = n => n.length >= 3 && n.length <= 20 && /^[\p{L}\p{N} _.\-]+$/u.test(n);
const cleanG = s => String(s || '').replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim();
async function guildView(a) {
  const g = await G.gById(a.guild); if (!g) return null; const mem = await G.members(g.id);
  return { id: g.id, name: g.name, tag: g.tag, descr: g.descr, open: g.open, wins: g.wins || 0, leader: g.leader, me: a.id, n: mem.length, max: GUILD_MAX,
    avg: mem.length ? Math.round(mem.reduce((s, m) => s + m.lvl, 0) / mem.length) : 0,
    members: mem.map(m => ({ id: m.id, name: m.op ? 'Operador level 0' : m.name, lvl: m.lvl, cls: m.cls, leader: m.id === g.leader })),
    reqs: g.leader === a.id ? (g.reqs || []) : [] };
}
function rewardText(r) {
  const t = []; if (r.dia) t.push(r.dia + ' diamantes'); if (r.gold) t.push(r.gold + ' de ouro'); if (r.hp) t.push(r.hp + ' poções de vida'); if (r.mp) t.push(r.mp + ' poções de mana'); if (r.scroll) t.push(r.scroll + ' pergaminhos');
  for (const k of r.items || []) t.push(ITEMNAME[k] || k); return t.join(', ');
}
const ITEMNAME = { 'skin:1': 'Visual Cavaleiro Azul', 'skin:2': 'Visual Demônio Rubro', 'skin:3': 'Visual Paladino Dourado', 'skin:4': 'Visual Mago Arcano', 'skin:5': 'Visual Assassino Sombrio', 'skin:6': 'Visual Príncipe do Gelo', 'skin:7': 'Visual Guerreiro Solar', 'skin:8': 'Visual Senhor do Vazio', 'skin:9': 'Visual Anjo Celestial', 'skin:10': 'Visual Cavaleiro de Cristal', 'title:apoiador': 'Selo Apoiador', 'cos:any.aura.10': 'Aura do Apoiador', 'pts:dia100': '100 diamantes', 'cos:any.aura.7': 'Aura de Campeão', 'cos:any.aura.8': 'Aura do Fundador', 'cos:any.trail.6': 'Rastro Cometa Arco-Íris', 'pal:neon': 'Paleta Neon',
  'ev:asas_fundador': 'Asas de Luz do Fundador', 'ev:coroa_torneio': 'Coroa do Primeiro Torneio', 'ev:capa_estelar': 'Capa Estelar', 'ev:dragao_cristal': 'Dragãozinho de Cristal', 'ev:estandarte': 'Estandarte de Guilda',
  'ev:coelho_pascoa': 'Coelho da Páscoa', 'ev:abobora': 'Abóbora Assombrada', 'ev:rena': 'Rena de Natal', 'ev:gorro_natal': 'Gorro de Natal', 'ev:chapeu_bruxa': 'Chapéu de Bruxa', 'ev:espada_alada': 'Espada Alada de Fogo', 'ev:arco_gelo': 'Arco do Relâmpago Gelado', 'ev:cajado_galaxia': 'Cajado da Galáxia' };
for (let i = 1; i <= 20; i++) ITEMNAME['cos:any.pet.' + i] = 'Mascote nº ' + i;
Object.assign(ITEMNAME, { 'cos:any.pet.16': 'Unicórnio Arco-Íris', 'cos:any.pet.19': 'Espírito da Floresta', 'cos:any.pet.20': 'Pequeno Arqueiro de Luz', 'cos:any.pet.25': 'Lobo Celestial', 'cos:any.aura.9': 'Aura Estelar', 'cos:any.trail.7': 'Rastro Estelar', 'cos:any.aura.4': 'Aura Sombras', 'cos:any.aura.5': 'Aura Dourada', 'cos:any.aura.6': 'Aura Arco-Íris', 'cos:any.trail.3': 'Rastro de Pétalas', 'cos:any.trail.4': 'Rastro de Estrelas', 'cos:any.trail.5': 'Rastro de Fogo' });
async function handleExtra(req, res, u, a) {
  { const r3 = await handleShop3(req, res, u, a); if (r3 !== null && r3 !== undefined) return r3; if (res.writableEnded) return true; }
  /* ---------- públicas ---------- */
  if (u === '/api/guild/rank') { const all = await G.stats(); return send(res, 200, { min: GUILD_RANK_MIN, list: all.filter(g => g.n >= GUILD_RANK_MIN).slice(0, 50).map((g, i) => ({ pos: i + 1, name: g.name, tag: g.tag, n: g.n, avg: g.avg, wins: g.wins || 0 })) }); }
  if (u === '/api/guild/list') { const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').toLowerCase(); const all = await G.stats(); return send(res, 200, { list: all.filter(g => !q || g.name.toLowerCase().includes(q) || g.tag.toLowerCase().includes(q)).slice(0, 40).map(g => ({ id: g.id, name: g.name, tag: g.tag, n: g.n, avg: g.avg, open: g.open, wins: g.wins || 0, descr: g.descr, full: g.n >= GUILD_MAX })) }); }
  if (u === '/api/war') { const w = await G.war(); return send(res, 200, { war: w ? { on: !!w.on, name: w.name, ends: w.ends, start: w.start, result: w.result || null } : null, board: w && w.on ? await G.warBoard(w) : [], now: Date.now() }); }
  if (!a) return null;
  /* ---------- guilda ---------- */
  if (u === '/api/guild/me') { await G.war(); return send(res, 200, { guild: await guildView(a), cost: GUILD_COST, dia: a.dia }); }
  if (u === '/api/guild/create' && req.method === 'POST') {
    const b = await body(req); if (a.guild && await G.gById(a.guild)) return send(res, 400, { err: 'Você já está numa guilda. Saia dela antes.' });
    const name = cleanG(b.name).slice(0, 20), tag = cleanG(b.tag).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (!okGuildName(name)) return send(res, 400, { err: 'O nome da guilda precisa ter de 3 a 20 letras ou números.' });
    if (tag.length < 2) return send(res, 400, { err: 'A sigla precisa ter de 2 a 4 letras ou números.' });
    if (/operador|admin|suporte/i.test(name)) return send(res, 400, { err: 'Esse nome é reservado.' });
    if (await G.gByName(name.toLowerCase())) return send(res, 409, { err: 'Já existe uma guilda com esse nome.' });
    const dia = await db.spendDia(a.id, GUILD_COST); if (dia === null) return send(res, 400, { err: 'Criar uma guilda custa ' + GUILD_COST + ' diamantes.', need: GUILD_COST });
    let g; try { g = await G.gCreate({ name, lname: name.toLowerCase(), tag, leader: a.id, descr: cleanG(b.descr).slice(0, 120) }); } catch (e) { await db.addDia(a.id, GUILD_COST); return send(res, 409, { err: 'Já existe uma guilda com esse nome.' }); }
    await db.set(a.id, { guild: g.id }); a.guild = g.id; return send(res, 200, { guild: await guildView(a), dia });
  }
  if (u === '/api/guild/join' && req.method === 'POST') {
    const b = await body(req); if (a.guild && await G.gById(a.guild)) return send(res, 400, { err: 'Você já está numa guilda.' });
    const g = await G.gById(+b.id); if (!g) return send(res, 404, { err: 'Guilda não encontrada.' });
    if (await G.count(g.id) >= GUILD_MAX) return send(res, 400, { err: 'Essa guilda está cheia.' });
    if (g.open) { await db.set(a.id, { guild: g.id }); a.guild = g.id; notify(g.leader, { t: 'gmsg', msg: a.name + ' entrou na sua guilda!' }); return send(res, 200, { guild: await guildView(a) }); }
    const reqs = (g.reqs || []).filter(r => r.id !== a.id); reqs.push({ id: a.id, name: a.name, lvl: a.lvl, at: Date.now() }); await G.gSet(g.id, { reqs: reqs.slice(-40) });
    notify(g.leader, { t: 'gmsg', msg: a.name + ' pediu para entrar na sua guilda.' }); return send(res, 200, { asked: true });
  }
  if (u === '/api/guild/leave' && req.method === 'POST') {
    const g = await G.gById(a.guild); await db.set(a.id, { guild: null }); if (!g) return send(res, 200, { ok: true });
    if (g.leader === a.id) { const rest = (await G.members(g.id)).filter(m => m.id !== a.id); if (!rest.length) await G.gDel(g.id); else { await G.gSet(g.id, { leader: rest[0].id }); notify(rest[0].id, { t: 'gmsg', msg: 'Agora você é o líder da guilda ' + g.name + '.' }); } }
    return send(res, 200, { ok: true });
  }
  const g = await G.gById(a.guild);
  if (u.startsWith('/api/guild/') && req.method === 'POST') {
    if (!g) return send(res, 400, { err: 'Você não está numa guilda.' });
    if (g.leader !== a.id) return send(res, 403, { err: 'Só o líder da guilda pode fazer isso.' });
    const b = await body(req);
    if (u === '/api/guild/accept') { const id = +b.id; const reqs = (g.reqs || []).filter(r => r.id !== id); await G.gSet(g.id, { reqs });
      if (b.yes) { const t = await db.byId(id); if (!t) return send(res, 404, { err: 'Jogador não encontrado.' }); if (t.guild && await G.gById(t.guild)) return send(res, 400, { err: t.name + ' já entrou em outra guilda.' }); if (await G.count(g.id) >= GUILD_MAX) return send(res, 400, { err: 'A guilda está cheia.' }); await db.set(id, { guild: g.id }); notify(id, { t: 'gmsg', msg: 'Você foi aceito na guilda ' + g.name + '!' }); }
      return send(res, 200, { guild: await guildView(a) }); }
    if (u === '/api/guild/kick') { const id = +b.id; if (id === a.id) return send(res, 400, { err: 'Use "Sair da guilda".' }); const t = await db.byId(id); if (t && t.guild === g.id) { await db.set(id, { guild: null }); notify(id, { t: 'gmsg', msg: 'Você saiu da guilda ' + g.name + '.' }); } return send(res, 200, { guild: await guildView(a) }); }
    if (u === '/api/guild/lead') { const id = +b.id; const t = await db.byId(id); if (!t || t.guild !== g.id) return send(res, 400, { err: 'Esse jogador não é da guilda.' }); await G.gSet(g.id, { leader: id }); notify(id, { t: 'gmsg', msg: 'Agora você é o líder da guilda ' + g.name + '.' }); return send(res, 200, { guild: await guildView(a) }); }
    if (u === '/api/guild/edit') { const f = {}; if (b.descr !== undefined) f.descr = cleanG(b.descr).slice(0, 120); if (b.open !== undefined) f.open = !!b.open; if (Object.keys(f).length) await G.gSet(g.id, f); return send(res, 200, { guild: await guildView(a) }); }
    if (u === '/api/guild/disband') { await G.gDel(g.id); return send(res, 200, { ok: true }); }
  }
  /* ---------- guerra ---------- */
  if (u === '/api/war/pts' && req.method === 'POST') {
    const b = await body(req); const w = await G.war(); if (!w || !w.on || !g) return send(res, 200, { ok: false });
    if (limited(req, 'wp' + a.id, 6, 60e3)) return send(res, 429, { err: 'devagar' });
    let n = Math.max(0, Math.min(150, b.n | 0)); if (!n) return send(res, 200, { ok: true });
    if (pool) { const r = await G.q('select pts from war_pts where war=$1 and acc=$2', [w.id, a.id]); const cur = r[0] ? r[0].pts : 0; n = Math.min(n, WAR_PTS_MAX - cur); if (n > 0) await pool.query('insert into war_pts(war,acc,guild,pts) values($1,$2,$3,$4) on conflict (war,acc) do update set pts=war_pts.pts+$4, guild=$3', [w.id, a.id, g.id, n]); }
    else { const k = w.id + ':' + a.id; const p = MEM.wpts[k] || (MEM.wpts[k] = { war: w.id, acc: a.id, guild: g.id, pts: 0 }); n = Math.min(n, WAR_PTS_MAX - p.pts); if (n > 0) { p.pts += n; p.guild = g.id; } db.saveMem(); }
    return send(res, 200, { ok: true, got: Math.max(0, n) });
  }
  if (u === '/api/war/start' && req.method === 'POST') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const b = await body(req); const old = await G.war(); if (old && old.on) return send(res, 400, { err: 'Já tem uma guerra acontecendo.' });
    const h = Math.max(0.1, Math.min(24 * 14, +b.hours || 24)); const w = { id: ((old && old.id) || 0) + 1, on: true, name: cleanG(b.name).slice(0, 40) || 'Guerra de Guildas', start: Date.now(), ends: Date.now() + h * 3600e3 }; await G.kvSet('war', w); return send(res, 200, { war: w }); }
  if (u === '/api/war/stop' && req.method === 'POST') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const w = await G.kvGet('war'); if (!w || !w.on) return send(res, 400, { err: 'Não tem guerra acontecendo.' }); return send(res, 200, { war: await G.warEnd(w) }); }
  /* ---------- códigos ---------- */
  if (u === '/api/redeem' && req.method === 'POST') {
    if (limited(req, 'rd' + a.id, 10, 600e3)) return send(res, 429, { err: 'Muitas tentativas. Espere alguns minutos.' });
    const b = await body(req); const code = normCode(b.code); if (code.length < 4) return send(res, 400, { err: 'Digite o código.' });
    const h = shaCode(code); const c = await G.codeGet(h); if (!c) return send(res, 404, { err: 'Código inválido.' });
    if (c.until && new Date(c.until).getTime() < Date.now()) return send(res, 400, { err: 'Este código já expirou.' });
    const st = await G.codeUse(h, a.id); if (st === 'used') return send(res, 400, { err: 'Você já usou este código.' }); if (st === 'out') return send(res, 400, { err: 'Este código já foi usado o máximo de vezes.' });
    const r = typeof c.reward === 'string' ? JSON.parse(c.reward) : c.reward; let dia = a.dia;
    if (r.dia) dia = await db.addDia(a.id, r.dia | 0);
    const fresh = await db.byId(a.id); const owned = fresh.owned || {};
    for (const k of r.items || []) owned[k] = 1;
    if (r.gold || r.hp || r.mp || r.scroll) { owned.gifts = (owned.gifts || []).concat([{ gold: r.gold | 0, hp: r.hp | 0, mp: r.mp | 0, scroll: r.scroll | 0, from: c.note || 'Código' }]).slice(-20); }
    await db.set(a.id, { owned });
    notify(a.id, { t: 'gift' });
    return send(res, 200, { ok: true, dia, owned, text: rewardText(r), note: c.note || '' });
  }
  if (u === '/api/gifts/take' && req.method === 'POST') { const fresh = await db.byId(a.id); const owned = fresh.owned || {}; const gifts = owned.gifts || []; if (!gifts.length) return send(res, 200, { gifts: [], owned }); delete owned.gifts; await db.set(a.id, { owned }); return send(res, 200, { gifts, owned }); }
  if (u === '/api/code/create' && req.method === 'POST') {
    if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const b = await body(req); const n = Math.max(1, Math.min(200, b.count | 0 || 1)); const r = b.reward || {};
    const rw = { dia: Math.max(0, Math.min(5000, r.dia | 0)), gold: Math.max(0, Math.min(1e7, r.gold | 0)), hp: Math.max(0, Math.min(500, r.hp | 0)), mp: Math.max(0, Math.min(500, r.mp | 0)), scroll: Math.max(0, Math.min(200, r.scroll | 0)), items: (r.items || []).filter(k => typeof k === 'string' && /^(cos:|ev:|pal:|mount:|frame:|skin:)[\w.:]+$/.test(k)).slice(0, 10) };
    if (!rw.dia && !rw.gold && !rw.hp && !rw.mp && !rw.scroll && !rw.items.length) return send(res, 400, { err: 'Escolha pelo menos um prêmio.' });
    const max = Math.max(1, Math.min(100000, b.max | 0 || 1)); const until = b.days ? new Date(Date.now() + Math.min(3650, +b.days) * 864e5).toISOString() : null; const note = cleanG(b.note).slice(0, 60) || 'Código especial';
    const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const rnd = k => Array.from(crypto.randomBytes(k), x => AL[x % 32]).join(''); const out = [];
    for (let i = 0; i < n; i++) { let plain = b.code && n === 1 ? normCode(b.code) : 'ELD' + rnd(4) + rnd(4); if (plain.length < 4) return send(res, 400, { err: 'Código muito curto.' }); const h = shaCode(plain); if (await G.codeGet(h)) { if (b.code) return send(res, 409, { err: 'Esse código já existe.' }); i--; continue; }
      await G.codeAdd({ h, plain, reward: rw, max, until, note }); out.push(plain.startsWith('ELD') && plain.length === 11 ? plain.slice(0, 3) + '-' + plain.slice(3, 7) + '-' + plain.slice(7) : plain); }
    return send(res, 200, { codes: out, text: rewardText(rw) });
  }
  if (u === '/api/op/gift' && req.method === 'POST') {
    if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const b = await body(req);
    const t = await db.byName(cleanName(b.name || '').toLowerCase()); if (!t) return send(res, 404, { err: 'Não achei nenhum jogador com esse nome.' });
    const owned = t.owned || {}; const keys = (b.keys || []).filter(k => typeof k === 'string' && /^(cos:|ev:|pal:|mount:|frame:|skin:)[\w.:]+$/.test(k)).slice(0, 200); for (const k of keys) owned[k] = 1;
    const g = { gold: Math.max(0, Math.min(1e8, b.gold | 0)), hp: Math.max(0, Math.min(5000, b.hp | 0)), mp: Math.max(0, Math.min(5000, b.mp | 0)), scroll: 0, from: 'Presente do Operador' };
    if (g.gold || g.hp || g.mp) owned.gifts = (owned.gifts || []).concat([g]).slice(-20);
    await db.set(t.id, { owned }); let dia = t.dia; const nd = Math.max(0, Math.min(100000, b.dia | 0)); if (nd) dia = await db.addDia(t.id, nd);
    const parts = []; if (nd) parts.push(nd + ' diamantes'); if (g.gold) parts.push(g.gold + ' de ouro'); if (g.hp) parts.push(g.hp + ' poções de vida'); if (g.mp) parts.push(g.mp + ' poções de mana'); for (const k of keys) parts.push(ITEMNAME[k] || b.names && b.names[k] || k.split('.').pop());
    if (!parts.length) return send(res, 400, { err: 'Escolha pelo menos um presente.' });
    const txt = parts.join(', '); notify(t.id, { t: 'gmsg', msg: '🎁 O Operador te deu um presente: ' + txt + '!' }); notify(t.id, { t: 'gift' }); if (nd) notify(t.id, { t: 'dia', dia, add: nd, why: 'Presente do Operador' });
    console.log('presente do operador para', t.name, txt); return send(res, 200, { ok: true, name: t.name, text: txt });
  }
  if (u === '/api/op/grant' && req.method === 'POST') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const b = await body(req); const fresh = await db.byId(a.id); const owned = fresh.owned || {}; for (const k of (b.keys || []).slice(0, 500)) if (typeof k === 'string' && /^(cos:|ev:|pal:|mount:|frame:|skin:)[\w.:]+$/.test(k)) owned[k] = 1; await db.set(a.id, { owned }); return send(res, 200, { owned }); }
  if (u === '/api/code/list') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); return send(res, 200, { list: (await G.codeList()).map(c => ({ code: c.plain || '(código pronto)', text: rewardText(typeof c.reward === 'string' ? JSON.parse(c.reward) : c.reward), max: c.max, uses: c.uses, until: c.until, note: c.note })) }); }
  /* ---------- loja pelo site (só itens que ficam na conta) ---------- */
  return null;
}


/* ================= loja v3: itens de evento à venda, pacotes, presentes, histórico, coleções, eventos e passe ================= */
// itens de evento que passam a ser vendidos (os do Fundador, Coroa do Torneio e auras de Campeão/Fundador continuam exclusivos)
const EVSALE = { 'ev:gorro_natal': 150, 'ev:chapeu_bruxa': 150, 'ev:capa_estelar': 300, 'ev:estandarte': 200, 'ev:coelho_pascoa': 900, 'ev:abobora': 900, 'ev:rena': 900,
  'ev:dragao_cristal': 2000, 'ev:espada_alada': 400, 'ev:arco_gelo': 400, 'ev:cajado_galaxia': 400, 'cos:any.trail.6': 300,
  'cos:any.pet.16': 900, 'cos:any.pet.19': 2000, 'cos:any.pet.20': 2000 };
for (const k in EVSALE) SHOP[k] = { p: EVSALE[k], kind: 'perm' };
// montarias e molduras (só visuais). O Lobo Celestial e a Moldura Celestial são do Passe.
const SKINP = { 1: 600, 2: 900, 3: 900, 4: 800, 5: 800, 6: 1000, 7: 1200, 8: 1200, 9: 1500, 10: 1200 };   // visuais completos (só aparência)
for (const i in SKINP) EVSALE['skin:' + i] = SKINP[i];
Object.assign(EVSALE, { 'mount:cavalo': 600, 'mount:unic': 1200, 'mount:dragao': 2000, 'frame:1': 50, 'frame:2': 100, 'frame:3': 200, 'frame:4': 250, 'frame:5': 250 });
for (const k in EVSALE) SHOP[k] = { p: EVSALE[k], kind: 'perm' };
Object.assign(ITEMNAME, { 'mount:lobo': 'Montaria Lobo Celestial', 'mount:cavalo': 'Montaria Cavalo de Guerra', 'mount:unic': 'Montaria Unicórnio Arco-Íris', 'mount:dragao': 'Montaria Dragão de Fogo', 'frame:1': 'Moldura de Bronze', 'frame:2': 'Moldura de Prata', 'frame:3': 'Moldura Real', 'frame:4': 'Moldura de Gelo', 'frame:5': 'Moldura de Fogo', 'frame:6': 'Moldura Celestial' });
const BUNDLES = {
  natal: { n: 'Kit Natal', items: ['ev:gorro_natal', 'ev:rena'] },
  halloween: { n: 'Kit Halloween', items: ['ev:chapeu_bruxa', 'ev:abobora'] },
  estelar: { n: 'Kit Estelar', items: ['ev:capa_estelar', 'cos:any.trail.6', 'ev:dragao_cristal'] },
  armas: { n: 'Kit Armas Lendárias', items: ['ev:espada_alada', 'ev:arco_gelo', 'ev:cajado_galaxia'] },
  brilho: { n: 'Kit Brilho', items: ['cos:any.aura.5', 'cos:any.trail.4', 'pal:neon'] },
  montaria: { n: 'Kit Cavaleiro', items: ['mount:cavalo', 'frame:3'] },
};
const BUNDLE_OFF = 0.2;
const COLL = [
  { id: 'natal', n: 'Natal', items: ['ev:gorro_natal', 'ev:rena'], reward: 'title:natal' },
  { id: 'halloween', n: 'Halloween', items: ['ev:chapeu_bruxa', 'ev:abobora'], reward: 'title:halloween' },
  { id: 'pascoa', n: 'Páscoa', items: ['ev:coelho_pascoa', 'cos:any.pet.4'], reward: 'title:pascoa' },
  { id: 'estelar', n: 'Estelar', items: ['ev:capa_estelar', 'cos:any.trail.6', 'ev:dragao_cristal'], reward: 'title:estelar' },
  { id: 'fundador', n: 'Fundador', items: ['ev:asas_fundador', 'cos:any.aura.8'], reward: 'title:fundador' },
  { id: 'armas', n: 'Armas Lendárias', items: ['ev:espada_alada', 'ev:arco_gelo', 'ev:cajado_galaxia'], reward: 'title:armeiro' },
];
// eventos com datas reais (horário de Brasília)
const EVENTS = [
  { id: 'natal2026', n: 'Natal em Eldmor', from: '2026-12-15T00:00:00-03:00', to: '2027-01-06T23:59:59-03:00', gift: { dia: 20, gold: 2000, hp: 3, mp: 3 }, coll: 'natal' },
  { id: 'pascoa2027', n: 'Páscoa em Eldmor', from: '2027-03-21T00:00:00-03:00', to: '2027-04-04T23:59:59-03:00', gift: { dia: 20, gold: 2000, hp: 3, mp: 3 }, coll: 'pascoa' },
  { id: 'halloween2027', n: 'Halloween em Eldmor', from: '2027-10-24T00:00:00-03:00', to: '2027-11-02T23:59:59-03:00', gift: { dia: 20, gold: 2000, hp: 3, mp: 3 }, coll: 'halloween' },
  { id: 'aniv2027', n: '1º Aniversário de Eldmor', from: '2027-11-01T00:00:00-03:00', to: '2027-11-15T23:59:59-03:00', gift: { dia: 50, gold: 5000, hp: 5, mp: 5 }, coll: null },
];
// passe de temporada
const PASS = { s: 1, n: 'Estrelas de Eldmor', from: '2026-11-07T00:00:00-03:00', to: '2027-01-31T23:59:59-03:00', price: 450, tiers: 30, per: 500 };
const MISS = { d1: { n: 'Derrote 40 monstros', xp: 50, per: 'd' }, d2: { n: 'Derrote 1 chefe', xp: 60, per: 'd' }, d3: { n: 'Jogue 20 minutos', xp: 40, per: 'd' },
  w1: { n: 'Derrote 400 monstros', xp: 200, per: 'w' }, w2: { n: 'Derrote 5 chefes', xp: 250, per: 'w' }, w3: { n: 'Jogue 3 horas', xp: 200, per: 'w' } };
function passReward(track, t) {
  if (track === 'f') { if (t === 30) return { dia: 30, items: ['title:estrela'] }; if (t % 5 === 0) return { dia: 15 }; return t % 2 ? { gold: 300 + t * 60 } : { hp: 2, mp: 2 }; }
  if (t === 1) return { items: ['cos:any.aura.9'] }; if (t === 10) return { items: ['cos:any.trail.7'] }; if (t === 15) return { items: ['frame:6'] }; if (t === 20) return { items: ['cos:any.pet.25'] }; if (t === 25) return { items: ['mount:lobo'] };
  if (t === 30) return { dia: 30, items: ['title:lenda'] }; if (t % 3 === 0) return { dia: 20 }; if (t % 3 === 1) return { gold: 800 + t * 100 }; return { hp: 4, mp: 4, scroll: 1 };
}
const brtDay = (d = new Date()) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
const brtWeek = (d = new Date()) => { const x = new Date(d.getTime() - 3 * 3600e3); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); };
const passActive = () => { const n = Date.now(); return n >= Date.parse(PASS.from) && n <= Date.parse(PASS.to); };
function passState(o) { const p = o.pass && o.pass.s === PASS.s ? o.pass : { s: PASS.s, xp: 0, prem: false, cf: [], cp: [] };
  const d = brtDay(), w = brtWeek(); if (!p.md || p.md.k !== d) p.md = { k: d, done: [] }; if (!p.mw || p.mw.k !== w) p.mw = { k: w, done: [] }; return p; }
const passLvl = p => Math.min(PASS.tiers, Math.floor((p.xp || 0) / PASS.per));
// trava por conta: evita compras duplicadas quando o botão é apertado duas vezes ou duas abas compram juntas
const S3LOCK = new Map();
function withLock(id, fn) { const prev = S3LOCK.get(id) || Promise.resolve(); const run = prev.then(fn, fn); const tail = run.catch(() => {}); S3LOCK.set(id, tail); tail.then(() => { if (S3LOCK.get(id) === tail) S3LOCK.delete(id); }); return run; }
const S3 = {
  async init() {
    if (pool) { await pool.query(`create table if not exists tx(id serial primary key, acc int not null, kind text not null, item text, price int not null default 0, other text, rid text, at timestamptz default now())`);
      await pool.query('create unique index if not exists tx_rid on tx(acc, rid) where rid is not null'); await pool.query('create index if not exists tx_acc on tx(acc, id desc)'); }
    else { MEM.tx = MEM.tx || []; MEM.txn = MEM.txn || 1; }
  },
  async txFind(acc, rid) { if (!rid) return null; if (pool) return (await pool.query('select * from tx where acc=$1 and rid=$2', [acc, rid])).rows[0] || null; return MEM.tx.find(t => t.acc === acc && t.rid === rid) || null; },
  async txAdd(acc, kind, item, price, other, rid) { if (pool) { await pool.query('insert into tx(acc,kind,item,price,other,rid) values($1,$2,$3,$4,$5,$6) on conflict do nothing', [acc, kind, item, price, other || null, rid || null]); return; }
    MEM.tx.push({ id: MEM.txn++, acc, kind, item, price, other: other || null, rid: rid || null, at: new Date().toISOString() }); if (MEM.tx.length > 20000) MEM.tx.splice(0, 5000); db.saveMem(); },
  async txList(acc) { if (pool) { const t = (await pool.query('select kind,item,price,other,at from tx where acc=$1 order by id desc limit 60', [acc])).rows; const p = (await pool.query('select id,dia,status,at from payments where acc=$1 order by at desc limit 30', [acc])).rows; return { tx: t, pays: p }; }
    return { tx: MEM.tx.filter(t => t.acc === acc).slice(-60).reverse(), pays: Object.entries(MEM.pays || {}).filter(([, v]) => v.acc === acc).map(([id, v]) => ({ id, dia: v.dia, status: v.st || v.status, at: v.at || null })) }; },
  grant(owned, r) { for (const k of r.items || []) owned[k] = 1; if (r.gold || r.hp || r.mp || r.scroll) owned.gifts = (owned.gifts || []).concat([{ gold: r.gold | 0, hp: r.hp | 0, mp: r.mp | 0, scroll: r.scroll | 0, from: r.from || 'Recompensa' }]).slice(-20); },
};
const validRid = r => typeof r === 'string' && /^[\w-]{8,64}$/.test(r) ? r : null;
const sellable = k => { const it = SHOP[k]; return it && it.kind === 'perm' ? it : null; };
async function handleShop3(req, res, u, a) {
  if (u === '/api/shop3') {
    return send(res, 200, { bundles: Object.fromEntries(Object.entries(BUNDLES).map(([k, b]) => [k, { n: b.n, items: b.items, full: b.items.reduce((s, i) => s + SHOP[i].p, 0), off: BUNDLE_OFF }])),
      coll: COLL, events: EVENTS.map(e => ({ id: e.id, n: e.n, from: e.from, to: e.to, gift: e.gift, coll: e.coll })), pass: Object.assign({}, PASS, { miss: MISS, rewards: { f: Array.from({ length: PASS.tiers }, (_, i) => passReward('f', i + 1)), p: Array.from({ length: PASS.tiers }, (_, i) => passReward('p', i + 1)) } }), now: new Date().toISOString() });
  }
  if (u === '/api/siteinfo') return send(res, 200, { bonus: SITE.bonus, ptsPerReal: SITE.ptsPerReal, perks: SITE.perks, ptshop: PTSHOP, packs: PACKS, month: brtMonth(), gplay: !!GPLAY_SA });
  if (!a) return null;
  if (u === '/api/pts/buy' && req.method === 'POST') {
    const b = await body(req); const key = String(b.item || ''); const it = PTSHOP[key]; if (!it) return send(res, 400, { err: 'Item desconhecido.' });
    return withLock(a.id, async () => {
      const f = await db.byId(a.id); const owned = f.owned || {}; if (!it.dia && owned[key]) return send(res, 400, { err: 'Você já tem este item.' });
      if ((owned.pts || 0) < it.pts) return send(res, 400, { err: 'Pontos insuficientes. Faltam ' + (it.pts - (owned.pts || 0)) + '.' });
      owned.pts -= it.pts; let dia = f.dia; if (it.dia) dia = await db.addDia(a.id, it.dia); else owned[key] = 1;
      await db.set(a.id, { owned }); await S3.txAdd(a.id, 'pontos', key, 0, it.pts + ' pontos', validRid(b.rid)); return send(res, 200, { ok: true, dia, owned });
    });
  }
  if (u === '/api/gplay/verify' && req.method === 'POST') {
    const b = await body(req); const pid = String(b.product || ''), tok = String(b.token || ''); const pk = PACKS[pid];
    if (!pk || pk.site || !/^[\w.\-:]{20,600}$/.test(tok)) return send(res, 400, { err: 'Compra inválida.' });
    if (!GPLAY_SA) return send(res, 503, { err: 'Compras pela Google Play ainda não foram ativadas no servidor.' });
    return withLock(a.id, async () => {
      let g; try { g = await gplay('/purchases/products/' + encodeURIComponent(pid) + '/tokens/' + encodeURIComponent(tok)); } catch (e) { console.log('gplay verify', e.message); return send(res, 502, { err: 'Não consegui confirmar a compra com o Google. Tente de novo em instantes.' }); }
      if (g.purchaseState !== 0) return send(res, 400, { err: g.purchaseState === 2 ? 'Pagamento pendente. Os diamantes chegam quando o Google aprovar.' : 'Essa compra foi cancelada.', pending: g.purchaseState === 2 });
      if (g.obfuscatedExternalAccountId && g.obfuscatedExternalAccountId !== String(a.id)) return send(res, 403, { err: 'Essa compra pertence a outra conta.' });
      const id = 'gp:' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 40);
      const fresh = await db.payNew(id, a.id, pk.dia, 'approved'); let dia;
      if (fresh) { dia = await db.addDia(a.id, pk.dia); await S3.txAdd(a.id, 'google', pk.n, 0, g.orderId || null, id); console.log('google play aprovado', g.orderId, 'conta', a.id, '+' + pk.dia); }
      else dia = (await db.byId(a.id)).dia;
      if (g.consumptionState === 0) try { await gplay('/purchases/products/' + encodeURIComponent(pid) + '/tokens/' + encodeURIComponent(tok) + ':consume', 'POST'); } catch (e) { console.log('gplay consume', e.message); }
      return send(res, 200, { ok: true, dia, add: fresh ? pk.dia : 0, dup: !fresh });
    });
  }
  if (u === '/api/history') return send(res, 200, await S3.txList(a.id));
  if (u === '/api/spend' && req.method === 'POST') {
    const b = await body(req); const rid = validRid(b.rid); const key = String(b.item || ''); const it = SHOP[key]; if (!it) return send(res, 400, { err: 'Item desconhecido.' });
    return withLock(a.id, async () => {
      if (rid) { const old = await S3.txFind(a.id, rid); if (old) { const f = await db.byId(a.id); return send(res, 200, { dia: f.dia, owned: f.owned || {}, item: key, dup: true }); } }
      const fresh = await db.byId(a.id); const owned = fresh.owned || {}; const d = today();
      if (it.kind === 'perm' && owned[key]) return send(res, 400, { err: 'Você já tem este item.' });
      if (it.kind === 'count' && (owned[key] || 0) >= it.max) return send(res, 400, { err: 'Você já comprou o máximo deste item.' });
      if (it.day) { const k2 = key + '@' + d; if ((owned[k2] || 0) >= it.day) return send(res, 400, { err: 'Limite de hoje atingido. Volte amanhã.' }); }
      const dia = await db.spendDia(a.id, it.p); if (dia === null) return send(res, 400, { err: 'Diamantes insuficientes.', need: it.p });
      if (it.kind === 'perm') owned[key] = 1; else if (it.kind === 'count') owned[key] = (owned[key] || 0) + 1;
      if (it.day) { for (const k in owned) if (k.includes('@') && !k.endsWith(d)) delete owned[k]; owned[key + '@' + d] = (owned[key + '@' + d] || 0) + 1; }
      await db.set(a.id, { owned }); await S3.txAdd(a.id, 'compra', key, it.p, null, rid); return send(res, 200, { dia, owned, item: key });
    });
  }
  if (u === '/api/bundle' && req.method === 'POST') {
    const b = await body(req); const rid = validRid(b.rid); const B = BUNDLES[b.id]; if (!B) return send(res, 400, { err: 'Pacote desconhecido.' });
    return withLock(a.id, async () => {
      if (rid && await S3.txFind(a.id, rid)) { const f = await db.byId(a.id); return send(res, 200, { dia: f.dia, owned: f.owned || {}, dup: true }); }
      const fresh = await db.byId(a.id); const owned = fresh.owned || {}; const miss = B.items.filter(k => !owned[k]);
      if (!miss.length) return send(res, 400, { err: 'Você já tem todos os itens deste pacote.' });
      const price = Math.round(miss.reduce((s, k) => s + SHOP[k].p, 0) * (1 - BUNDLE_OFF));
      if (b.price != null && +b.price !== price) return send(res, 409, { err: 'O preço mudou. Confira de novo.', price });
      const dia = await db.spendDia(a.id, price); if (dia === null) return send(res, 400, { err: 'Diamantes insuficientes.', need: price });
      for (const k of miss) owned[k] = 1; await db.set(a.id, { owned }); await S3.txAdd(a.id, 'pacote', B.n + ': ' + miss.join(','), price, null, rid); return send(res, 200, { dia, owned, got: miss });
    });
  }
  if (u === '/api/gift' && req.method === 'POST') {
    if (limited(req, 'gift', 30, 3600e3)) return send(res, 429, { err: 'Muitos presentes seguidos. Espere um pouco.' });
    const b = await body(req); const rid = validRid(b.rid); const key = String(b.item || ''); const it = sellable(key); if (!it) return send(res, 400, { err: 'Este item não pode ser presenteado.' });
    const ln = String(b.to || '').trim().toLowerCase(); if (!ln) return send(res, 400, { err: 'Digite o nome do jogador.' });
    const t = await db.byName(ln); if (!t) return send(res, 404, { err: 'Não achei nenhum jogador com esse nome.' }); if (t.id === a.id) return send(res, 400, { err: 'Para você mesmo, use o botão Comprar.' });
    return withLock(a.id, async () => {
      if (rid && await S3.txFind(a.id, rid)) { const f = await db.byId(a.id); return send(res, 200, { dia: f.dia, dup: true, to: t.name }); }
      return withLock(t.id, async () => {
        const tf = await db.byId(t.id); const towned = tf.owned || {}; if (towned[key]) return send(res, 400, { err: t.name + ' já tem este item.' });
        const dia = await db.spendDia(a.id, it.p); if (dia === null) return send(res, 400, { err: 'Diamantes insuficientes.', need: it.p });
        towned[key] = 1; towned.gifts = (towned.gifts || []).concat([{ gold: 0, hp: 0, mp: 0, scroll: 0, from: a.name }]).slice(-20); await db.set(t.id, { owned: towned });
        await S3.txAdd(a.id, 'presente enviado', key, it.p, t.name, rid); await S3.txAdd(t.id, 'presente recebido', key, 0, a.name, null);
        notify(t.id, { t: 'gift' }); notify(t.id, { t: 'gmsg', msg: a.name + ' te deu um presente: ' + (ITEMNAME[key] || key) + '!' });
        return send(res, 200, { dia, to: t.name });
      });
    });
  }
  if (u === '/api/collection/claim' && req.method === 'POST') {
    const b = await body(req); const C = COLL.find(c => c.id === b.id); if (!C) return send(res, 400, { err: 'Coleção desconhecida.' });
    return withLock(a.id, async () => { const f = await db.byId(a.id); const owned = f.owned || {}; if (owned[C.reward]) return send(res, 400, { err: 'Você já pegou esta recompensa.' });
      if (C.items.some(k => !owned[k])) return send(res, 400, { err: 'Complete a coleção primeiro.' }); owned[C.reward] = 1; await db.set(a.id, { owned }); await S3.txAdd(a.id, 'coleção', C.reward, 0, C.n, null); return send(res, 200, { owned }); });
  }
  if (u === '/api/title' && req.method === 'POST') {
    const b = await body(req); const k = String(b.title || ''); return withLock(a.id, async () => { const f = await db.byId(a.id); const owned = f.owned || {};
      if (k && !(k.startsWith('title:') && owned[k])) return send(res, 400, { err: 'Você não tem este título.' }); owned.title = k || null; await db.set(a.id, { owned }); return send(res, 200, { owned }); });
  }
  if (u === '/api/event/claim' && req.method === 'POST') {
    const b = await body(req); const E = EVENTS.find(e => e.id === b.id); if (!E) return send(res, 400, { err: 'Evento desconhecido.' });
    const n = Date.now(); if (n < Date.parse(E.from) || n > Date.parse(E.to)) return send(res, 400, { err: 'Este evento não está acontecendo agora.' });
    return withLock(a.id, async () => { const f = await db.byId(a.id); const owned = f.owned || {}; const k = 'evc:' + E.id; if (owned[k]) return send(res, 400, { err: 'Você já pegou o presente deste evento.' });
      owned[k] = 1; S3.grant(owned, Object.assign({ from: E.n }, E.gift)); await db.set(a.id, { owned }); let dia = f.dia; if (E.gift.dia) dia = await db.addDia(a.id, E.gift.dia);
      await S3.txAdd(a.id, 'evento', E.id, 0, E.n, null); return send(res, 200, { dia, owned }); });
  }
  if (u === '/api/pass') { const f = await db.byId(a.id); return send(res, 200, { pass: passState(f.owned || {}), active: passActive() }); }
  if (u === '/api/pass/buy' && req.method === 'POST') {
    const b = await body(req); const rid = validRid(b.rid); if (!passActive()) return send(res, 400, { err: 'A temporada não está ativa.' });
    return withLock(a.id, async () => { const f = await db.byId(a.id); const owned = f.owned || {}; const p = passState(owned); if (p.prem) return send(res, 400, { err: 'Você já tem o Passe Premium.' });
      const dia = await db.spendDia(a.id, PASS.price); if (dia === null) return send(res, 400, { err: 'Diamantes insuficientes.', need: PASS.price });
      p.prem = true; owned.pass = p; await db.set(a.id, { owned }); await S3.txAdd(a.id, 'passe premium', 'pass:' + PASS.s, PASS.price, null, rid); return send(res, 200, { dia, pass: p, owned }); });
  }
  if (u === '/api/pass/mission' && req.method === 'POST') {
    const b = await body(req); const M = MISS[b.id]; if (!M) return send(res, 400, { err: 'Missão desconhecida.' }); if (!passActive()) return send(res, 400, { err: 'A temporada não está ativa.' });
    return withLock(a.id, async () => { const f = await db.byId(a.id); const owned = f.owned || {}; const p = passState(owned); const box = M.per === 'd' ? p.md : p.mw;
      if (box.done.includes(b.id)) return send(res, 400, { err: 'Missão já concluída neste período.' }); box.done.push(b.id); p.xp = Math.min(PASS.tiers * PASS.per, (p.xp || 0) + M.xp); owned.pass = p; await db.set(a.id, { owned }); return send(res, 200, { pass: p }); });
  }
  if (u === '/api/pass/claim' && req.method === 'POST') {
    const b = await body(req); const tr = b.track === 'p' ? 'p' : 'f', t = b.tier | 0; if (t < 1 || t > PASS.tiers) return send(res, 400, { err: 'Nível inválido.' });
    return withLock(a.id, async () => { const f = await db.byId(a.id); const owned = f.owned || {}; const p = passState(owned);
      if (t > passLvl(p)) return send(res, 400, { err: 'Você ainda não chegou neste nível do passe.' }); if (tr === 'p' && !p.prem) return send(res, 400, { err: 'Esta recompensa é do Passe Premium.' });
      const L = tr === 'p' ? p.cp : p.cf; if (L.includes(t)) return send(res, 400, { err: 'Recompensa já resgatada.' });
      const r = passReward(tr, t); L.push(t); owned.pass = p; S3.grant(owned, Object.assign({ from: 'Passe de Temporada' }, r)); await db.set(a.id, { owned }); let dia = f.dia; if (r.dia) dia = await db.addDia(a.id, r.dia);
      return send(res, 200, { dia, pass: p, owned, reward: r }); });
  }
  return null;
}

/* ---------- rotas ---------- */
async function handle(req, res, u) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (u === '/api/info') return send(res, 200, { ok: true, db: !!pool, pay: !!MP_TOKEN, payHint: MP_HINT, supportEmail: (process.env.SUPPORT_EMAIL || 'reinosdeeldmor@gmail.com').trim(), mpKey: MP_KEY ? JSON.stringify(MP_KEY) : '', packs: PACKS, shop: SHOP, rename: RENAME_COST, earnDay: EARN_DAY, guildCost: GUILD_COST });
    if (u === '/api/register' && req.method === 'POST') {
      if (limited(req, 'reg', +(process.env.REG_LIMIT || 6), 3600e3)) return send(res, 429, { err: 'Muitas contas criadas daqui. Tente mais tarde.' });
      const b = await body(req); const name = cleanName(b.name), pw = String(b.pass || '');
      if (!validName(name)) return send(res, 400, { err: 'O nome precisa ter de 3 a 16 letras ou números.' });
      if (pw.length < 4 || pw.length > 64) return send(res, 400, { err: 'A senha precisa ter pelo menos 4 caracteres.' });
      const op = isOpName(name);
      if (!op && /operador/i.test(name)) return send(res, 400, { err: 'Esse nome é reservado.' });
      const ln = name.toLowerCase(); if (await db.byName(ln)) return send(res, 409, { err: 'Esse nome já está em uso. Escolha outro.' });
      const salt = crypto.randomBytes(12).toString('hex'); const a = await db.create({ name, lname: ln, ph: hashPw(pw, salt), salt, op });
      if (b.terms) { a.owned = Object.assign({}, a.owned, { terms: today() }); await db.set(a.id, { owned: a.owned }); }
      return send(res, 200, { tok: await db.addTok(a.id), acc: pubAcc(a), save: null });
    }
    if (u === '/api/login' && req.method === 'POST') {
      if (limited(req, 'log', 20, 600e3)) return send(res, 429, { err: 'Muitas tentativas. Espere alguns minutos.' });
      const b = await body(req); const a = await db.byName(cleanName(b.name).toLowerCase());
      if (!a || hashPw(b.pass || '', a.salt) !== a.ph) return send(res, 401, { err: 'Nome ou senha errados.' });
      return send(res, 200, { tok: await db.addTok(a.id), acc: pubAcc(a), save: a.save || null });
    }
    if (u === '/api/rank') { const l = await db.rank(50); return send(res, 200, { list: l.map((x, i) => ({ pos: i + 1, name: x.name, lvl: x.lvl, cls: x.cls, title: x.title || null })) }); }
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
    if (u === '/api/support' && req.method === 'POST') {
      if (limited(req, 'sup', 5, 3600e3)) return send(res, 429, { err: 'Você já mandou várias mensagens. Espere um pouco.' });
      const b = await body(req); const msg = String(b.msg || '').replace(/[<>]/g, '').trim().slice(0, 2000); if (msg.length < 2) return send(res, 400, { err: 'Escreva sua mensagem.' });
      const who = await auth(req); await db.supAdd({ acc: who ? who.id : null, name: who ? who.name : cleanName(b.name) || null, contact: String(b.contact || '').replace(/[<>]/g, '').trim().slice(0, 120) || null, msg });
      try { const n = await db.supOpen(); for (const id of await db.opIds()) notify(id, { t: 'sup', n, from: who ? who.name : (cleanName(b.name) || 'Visitante') }); } catch (_) {}
      return send(res, 200, { ok: true });
    }
    if (u === '/api/guild/rank' || u === '/api/guild/list' || u === '/api/war' || u === '/api/shop3' || u === '/api/siteinfo') return handleExtra(req, res, u, null);
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
    if (u === '/api/spend_old' && req.method === 'POST') {
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
      if (pk.site && (a.owned || {})['mes@' + brtMonth()]) return send(res, 400, { err: 'Você já comprou o Pacote do Mês. Ele volta no mês que vem!' });
      if (!MP_TOKEN) return send(res, 503, { err: 'As compras ainda não foram ativadas neste servidor.' });
      const pref = await mpFetch('/checkout/preferences', { method: 'POST', body: JSON.stringify({
        items: [{ id: b.pack, title: 'Reinos de Eldmor - ' + pk.n, quantity: 1, currency_id: 'BRL', unit_price: pk.price }],
        external_reference: a.id + ':' + b.pack, notification_url: PUBLIC_URL + '/api/mp/webhook',
        back_urls: { success: PUBLIC_URL + '/api/mp/return', pending: PUBLIC_URL + '/api/mp/return', failure: PUBLIC_URL + '/api/mp/return' }, auto_return: 'approved',
        statement_descriptor: 'ELDMOR', metadata: { acc: a.id, pack: b.pack } }) });
      return send(res, 200, { url: pref.init_point });
    }
    if (u === '/api/op/players') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' });
      const on = new Map(); for (const o of onlineFn()) if (o.acc) on.set(o.acc, o); const guests = onlineFn().filter(o => !o.acc).length;
      let rows, spent = {}, paid = {};
      if (pool) {
        rows = (await pool.query("select id,name,lvl,cls,dia,earned,earn_day,created,updated,op,owned,(save->>'gold') as gold from accounts order by updated desc limit 1000")).rows;
        for (const r of (await pool.query("select acc,coalesce(sum(price),0)::int s,count(*)::int n from tx where price>0 group by acc")).rows) spent[r.acc] = r;
        for (const r of (await pool.query("select acc,coalesce(sum(dia),0)::int d,count(*)::int n from payments where status='approved' group by acc")).rows) paid[r.acc] = r;
      } else {
        rows = MEM.accs.map(x => Object.assign({}, x, { gold: x.save && x.save.gold })).sort((x, y) => String(y.updated || '').localeCompare(String(x.updated || '')));
        for (const t of MEM.tx || []) if (t.price > 0) { const o = spent[t.acc] || (spent[t.acc] = { s: 0, n: 0 }); o.s += t.price; o.n++; }
        for (const v of Object.values(MEM.pays || {})) if ((v.status || v.st) === 'approved') { const o = paid[v.acc] || (paid[v.acc] = { d: 0, n: 0 }); o.d += v.dia; o.n++; }
      }
      const today = new Date().toISOString().slice(0, 10);
      const list = rows.map(r => { const ow = r.owned || {}; const o = on.get(r.id); const pk = Object.values(PACKS);
        return { id: r.id, name: r.name, op: !!r.op, lvl: r.lvl, cls: r.cls, dia: r.dia | 0, gold: +r.gold || 0, earned: r.earn_day === today ? r.earned | 0 : 0,
          items: Object.keys(ow).filter(k => ow[k] === 1 || ow[k] === true).length, pass: !!(ow.pass && ow.pass.prem), title: ow.title || null,
          spent: (spent[r.id] || {}).s || 0, buys: (spent[r.id] || {}).n || 0, bought: (paid[r.id] || {}).d || 0, pays: (paid[r.id] || {}).n || 0,
          created: r.created || null, updated: r.updated || null, online: !!o, zone: o ? o.z : null }; });
      const real = list.filter(x => !x.op);
      return send(res, 200, { list, guests, sum: { accs: real.length, online: real.filter(x => x.online).length + guests, dia: real.reduce((t, x) => t + x.dia, 0), bought: real.reduce((t, x) => t + x.bought, 0), spent: real.reduce((t, x) => t + x.spent, 0), buyers: real.filter(x => x.pays).length } });
    }
    if (u === '/api/op/player') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const id = +new URL(req.url, 'http://x').searchParams.get('id'); const r = await db.byId(id); if (!r) return send(res, 404, { err: 'Conta não encontrada.' });
      const sv = r.save || {}; const ow = r.owned || {}; const hist = await S3.txList(r.id); const names = {}; for (const k of [...Object.keys(ow), ...hist.tx.map(t => t.item || '')]) if (ITEMNAME[k]) names[k] = ITEMNAME[k];
      return send(res, 200, { id: r.id, name: r.name, lvl: r.lvl, cls: r.cls, dia: r.dia | 0, gold: sv.gold | 0, hp: sv.pot ? sv.pot.hp | 0 : 0, mp: sv.pot ? sv.pot.mp | 0 : 0,
        bosses: sv.bosses ? Object.keys(sv.bosses).filter(k => sv.bosses[k]).length : 0, created: r.created || null, updated: r.updated || null,
        owned: Object.keys(ow).filter(k => ow[k] === 1 || ow[k] === true), pass: ow.pass ? { prem: !!ow.pass.prem, xp: ow.pass.xp | 0 } : null, title: ow.title || null, hist, names }); 
    }
    if (u === '/api/support/count') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); return send(res, 200, { n: await db.supOpen() }); }
    if (u === '/api/support/list') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); return send(res, 200, { list: await db.supList() }); }
    if (u === '/api/support/done' && req.method === 'POST') { if (!a.op) return send(res, 403, { err: 'Só o Operador.' }); const b = await body(req); await db.supDone(+b.id); return send(res, 200, { ok: true }); }
    if (u === '/api/delete' && req.method === 'POST') { const b = await body(req); if (hashPw(b.pass || '', a.salt) !== a.ph) return send(res, 401, { err: 'Senha errada.' }); await db.delAcc(a.id); return send(res, 200, { ok: true }); }
    if (u === '/api/logout' && req.method === 'POST') { await db.dropToks(a.id); return send(res, 200, { ok: true }); }
    if (await handleExtra(req, res, u, a) !== null) return;
    return send(res, 404, { err: 'rota desconhecida' });
  } catch (e) { console.log('api erro', u, e.message); return send(res, 500, { err: 'Erro no servidor. Tente de novo.' }); }
}
module.exports = { db, handle, setHooks(h) { if (h.isOpName) isOpName = h.isOpName; if (h.notify) notify = h.notify; if (h.online) onlineFn = h.online; }, pubAcc };
