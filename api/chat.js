// Chat de suporte ao vivo. Tudo é gravado para sempre no canal do Discord DISCORD_CHANNEL_SUPORTE.
//
// Como funciona o "ao vivo" numa hospedagem serverless (Vercel não mantém WebSocket):
//  - o app mantém uma requisição "long poll" aberta (até ~20 s). Ela responde NA HORA em que
//    chega uma mensagem nova e o app já abre a próxima, então a entrega fica em ~1 s;
//  - cada instância guarda um índice em memória das mensagens e consulta o Discord no máximo
//    1x por segundo ("after=último id"), não importa quantas pessoas estejam conectadas.
import { read_channel, find_user, discord_call, channels } from "../lib/store.js";
import { read_token, ADMIN_EMAIL } from "../lib/mercadopago.js";
import { account_state } from "../lib/gate.js";

export const config = { api: { bodyParser: { sizeLimit: "100kb" } } };

const HOLD_MS = 20000;        // tempo máximo que uma consulta fica esperando mensagem nova
const SYNC_EVERY_MS = 900;    // intervalo mínimo entre consultas ao Discord (por instância)
const LOAD_PAGES = Number(process.env.CHAT_SCAN_PAGES) || 100; // 100 páginas = 10.000 mensagens recentes
const LOAD_BUDGET_MS = 15000;
const MAX_TEXT = 900;
const PAGE = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newer = (a, b) => (a.length !== b.length ? a.length > b.length : a > b); // ids (snowflake) como texto
const max_id = (a, b) => (newer(a, b) ? a : b);

// ---------- índice em memória ----------
const idx = {
  ready: false, loading: null, syncing: null, synced_at: 0, latest: "0",
  ids: new Set(), by_cid: new Map(), staff_seen: new Map(), user_seen: new Map(),
};

function ingest(message) {
  if (!message?.id || idx.ids.has(message.id)) return null;
  let data;
  try { data = JSON.parse(message.content); } catch { return null; }
  if (!data || typeof data !== "object" || !data.c) return null;
  idx.ids.add(message.id);
  idx.latest = max_id(idx.latest, message.id);
  const cid = String(data.c);
  if (data.t === "seen") {
    const book = data.f === "s" ? idx.staff_seen : idx.user_seen;
    const upto = String(data.u || "0");
    if (newer(upto, book.get(cid) || "0")) book.set(cid, upto);
    return null;
  }
  if (data.t !== "chat") return null;
  const row = { id: message.id, cid, from: data.f === "s" ? "staff" : "user", by: String(data.b || ""), text: String(data.x || ""), at: Date.parse(data.at) || Number((BigInt(message.id) >> 22n) + 1420070400000n) };
  const list = idx.by_cid.get(cid) || [];
  list.push(row);
  list.sort((a, b) => (a.id === b.id ? 0 : newer(a.id, b.id) ? 1 : -1));
  idx.by_cid.set(cid, list);
  return row;
}

async function load_history() {
  const started = Date.now();
  let before = null;
  for (let page = 0; page < LOAD_PAGES && Date.now() - started < LOAD_BUDGET_MS; page++) {
    const batch = await discord_call("GET", `/channels/${channels.support}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const message of batch) ingest(message);
    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  idx.ready = true;
  idx.synced_at = Date.now();
}

const ensure = () => {
  if (idx.ready) return Promise.resolve();
  idx.loading = idx.loading || load_history().finally(() => { idx.loading = null; });
  return idx.loading;
};

async function sync(force = false) {
  await ensure();
  if (!force && Date.now() - idx.synced_at < SYNC_EVERY_MS) return;
  if (idx.syncing) return idx.syncing;
  idx.syncing = (async () => {
    for (let round = 0; round < 20; round++) {
      const batch = await discord_call("GET", `/channels/${channels.support}/messages?limit=100&after=${idx.latest}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const message of [...batch].sort((a, b) => (newer(a.id, b.id) ? 1 : -1))) ingest(message);
      if (batch.length < 100) break;
    }
    idx.synced_at = Date.now();
  })().finally(() => { idx.syncing = null; });
  return idx.syncing;
}

// espera até `check()` devolver algo ou até o tempo acabar
async function hold(check) {
  const end = Date.now() + HOLD_MS;
  for (;;) {
    await sync();
    const found = check();
    if (found) return found;
    if (Date.now() >= end) return null;
    await sleep(450);
  }
}

// ---------- gravação no Discord ----------
async function save_chat({ cid, from, by, text }) {
  const at = new Date().toISOString();
  const content = JSON.stringify({ t: "chat", c: cid, f: from === "staff" ? "s" : "u", b: by, x: text, at });
  if (content.length > 1990) return null;
  const embed = { author: { name: `${from === "staff" ? "Suporte" : "Usuário"} · ${by}`.slice(0, 250) }, description: text.slice(0, 1500), color: from === "staff" ? 0x2dd4bf : 0x818cf8, timestamp: at, footer: { text: `conversa ${cid}` } };
  const posted = await discord_call("POST", `/channels/${channels.support}/messages`, { content, embeds: [embed] });
  if (!posted?.id) throw new Error(posted?.message || "Falha ao gravar a mensagem no Discord");
  return ingest(posted);
}

async function save_seen(cid, who, upto) {
  const book = who === "staff" ? idx.staff_seen : idx.user_seen;
  if (!upto || !newer(upto, book.get(cid) || "0")) return;
  book.set(cid, upto);
  const posted = await discord_call("POST", `/channels/${channels.support}/messages`, { content: JSON.stringify({ t: "seen", c: cid, f: who === "staff" ? "s" : "u", u: upto }) });
  if (posted?.id) { idx.ids.add(posted.id); idx.latest = max_id(idx.latest, posted.id); }
}

// ---------- limites ----------
const sends = new Map();
function allow_send(key) {
  const now = Date.now();
  const recent = (sends.get(key) || []).filter((time) => now - time < 60000);
  if (recent.length >= 20 || (recent.length && now - recent[recent.length - 1] < 600)) { sends.set(key, recent); return false; }
  recent.push(now);
  sends.set(key, recent);
  return true;
}

// ---------- autenticação ----------
async function authenticate(body) {
  const session = read_token(body.token);
  if (!session) return null;
  const user = await find_user(session.email);
  if (!user || account_state(user) !== "active") return null;
  if (user.adm?.valid_after && session.issued_at < user.adm.valid_after) return null;
  const staff = user.email === ADMIN_EMAIL || ["admin", "support"].includes(user.adm?.role);
  return { user, staff };
}

const label = (user) => user.login || user.name || String(user.email || "").split("@")[0];
const clean = (value) => String(value ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
const publish = (row) => ({ id: row.id, from: row.from, text: row.text, at: row.at });
const tail = (list, before) => {
  const pool = before ? list.filter((row) => newer(before, row.id)) : list;
  return { messages: pool.slice(-PAGE).map(publish), more: pool.length > PAGE };
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });
  if (!channels.support) return res.status(503).json({ error: "Chat indisponível: falta configurar DISCORD_CHANNEL_SUPORTE.", code: "no_channel" });

  const { action, ...body } = req.body || {};
  const who = await authenticate(body);
  if (!who) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
  const { user } = who;

  try {
    // ======== lado do usuário ========
    if (action === "chat_open") {
      await sync(true);
      const cid = user.msg_id;
      const list = idx.by_cid.get(cid) || [];
      const page = tail(list, body.before ? String(body.before) : null);
      const last = list.length ? list[list.length - 1].id : null;
      if (!body.before && last) await save_seen(cid, "user", last);
      return res.status(200).json({ ok: true, ...page, latest: last, staff_seen: idx.staff_seen.get(cid) || "0" });
    }

    if (action === "chat_send") {
      const text = clean(body.text);
      if (!text) return res.status(400).json({ error: "Escreva uma mensagem." });
      if (!allow_send(`u:${user.msg_id}`)) return res.status(429).json({ error: "Calma! Aguarde um instante para enviar outra mensagem." });
      await ensure();
      const row = await save_chat({ cid: user.msg_id, from: "user", by: label(user), text });
      if (!row) return res.status(400).json({ error: "Mensagem longa demais. Divida em partes menores." });
      return res.status(200).json({ ok: true, message: publish(row) });
    }

    if (action === "chat_poll") {
      const cid = user.msg_id;
      const after = String(body.after || "0");
      const found = await hold(() => {
        const fresh = (idx.by_cid.get(cid) || []).filter((row) => newer(row.id, after));
        const seen = idx.staff_seen.get(cid) || "0";
        return fresh.length || seen !== String(body.seen || "0") ? { fresh, seen } : null;
      });
      const list = found?.fresh || [];
      if (list.length && list.some((row) => row.from === "staff") && body.focused) await save_seen(cid, "user", list[list.length - 1].id);
      return res.status(200).json({ ok: true, messages: list.map(publish), staff_seen: found?.seen ?? (idx.staff_seen.get(cid) || "0") });
    }

    if (action === "chat_seen") {
      await ensure();
      await save_seen(user.msg_id, "user", String(body.upto || ""));
      return res.status(200).json({ ok: true });
    }

    if (action === "chat_unread") {
      await sync();
      const cid = user.msg_id;
      const seen = idx.user_seen.get(cid) || "0";
      const fresh = (idx.by_cid.get(cid) || []).filter((row) => row.from === "staff" && newer(row.id, seen));
      return res.status(200).json({ ok: true, unread: fresh.length, last: fresh.length ? publish(fresh[fresh.length - 1]) : null });
    }

    // ======== lado da equipe (dono, admin e suporte) ========
    if (!action || !action.startsWith("staff_")) return res.status(400).json({ error: "Ação desconhecida" });
    if (!who.staff) return res.status(403).json({ error: "Acesso negado" });

    const people = async () => new Map((await read_channel("users")).map((row) => [row.msg_id, row]));
    const card = (person, cid) => ({ cid, login: person?.login || null, name: person?.name || null, email: person?.email || null, avatar: person?.avatar || null, plan: person?.plan || null, whatsapp: person?.whatsapp || null });
    const unread_of = (cid) => {
      const seen = idx.staff_seen.get(cid) || "0";
      return (idx.by_cid.get(cid) || []).filter((row) => row.from === "user" && newer(row.id, seen)).length;
    };
    const unread_total = () => [...idx.by_cid.keys()].filter((cid) => unread_of(cid) > 0).length;

    if (action === "staff_inbox") {
      await sync(true);
      const users = await people();
      const rows = [...idx.by_cid.entries()].map(([cid, list]) => {
        const last = list[list.length - 1];
        return { ...card(users.get(cid), cid), last: publish(last), unread: unread_of(cid), total: list.length };
      }).sort((a, b) => (newer(a.last.id, b.last.id) ? -1 : 1)).slice(0, 300);
      return res.status(200).json({ ok: true, conversations: rows, latest: idx.latest, unread_total: unread_total() });
    }

    if (action === "staff_thread") {
      await sync(true);
      const cid = String(body.cid || "");
      const users = await people();
      const list = idx.by_cid.get(cid) || [];
      const page = tail(list, body.before ? String(body.before) : null);
      return res.status(200).json({ ok: true, person: card(users.get(cid), cid), ...page, latest: list.length ? list[list.length - 1].id : null, user_seen: idx.user_seen.get(cid) || "0" });
    }

    if (action === "staff_send") {
      const cid = String(body.cid || "");
      const text = clean(body.text);
      if (!text) return res.status(400).json({ error: "Escreva uma mensagem." });
      if (!(await people()).has(cid)) return res.status(404).json({ error: "Usuário não encontrado" });
      if (!allow_send(`s:${user.msg_id}`)) return res.status(429).json({ error: "Aguarde um instante para enviar outra mensagem." });
      await ensure();
      const row = await save_chat({ cid, from: "staff", by: label(user), text });
      if (!row) return res.status(400).json({ error: "Mensagem longa demais. Divida em partes menores." });
      await save_seen(cid, "staff", row.id);
      return res.status(200).json({ ok: true, message: publish(row) });
    }

    if (action === "staff_seen") {
      await ensure();
      await save_seen(String(body.cid || ""), "staff", String(body.upto || ""));
      return res.status(200).json({ ok: true, unread_total: unread_total() });
    }

    // consulta global: qualquer mensagem nova de qualquer usuário, para badge, som e notificação
    if (action === "staff_poll") {
      const after = String(body.after || "0");
      const found = await hold(() => {
        const fresh = [];
        for (const list of idx.by_cid.values()) for (const row of list) if (newer(row.id, after)) fresh.push(row);
        return fresh.length ? fresh : null;
      });
      const users = found ? await people() : null;
      const messages = (found || []).sort((a, b) => (newer(a.id, b.id) ? 1 : -1)).slice(-100).map((row) => ({ ...publish(row), cid: row.cid, person: users ? card(users.get(row.cid), row.cid) : null }));
      return res.status(200).json({ ok: true, messages, latest: idx.latest, unread_total: unread_total() });
    }

    return res.status(400).json({ error: "Ação desconhecida" });
  } catch (error) {
    console.error("[chat]", action, error);
    return res.status(500).json({ error: error.message || "Erro interno" });
  }
}
