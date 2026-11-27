export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

import { fit_content, get_settings, get_config, list_config, log_event, snowflake_time, read_channel, get_row, patch_row, invalidate, get_blocklist } from "../lib/store.js";
import { request_context, compact_context, log_context } from "../lib/telemetry.js";
import { check_signup, check_login, blocked_message } from "../lib/gate.js";
import {
  make_token, verify_token, read_token, hash_password, verify_password, verify_google, GOOGLE_CLIENT_ID,
  norm_phone, valid_pix_key, valid_doc, normalize_pix_key, PIX_TYPES, only_digits,
  process_withdrawal, PAYOUTS_ENABLED, MpError,
} from "../lib/mercadopago.js";

const DISCORD_API = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_USUARIOS   = process.env.DISCORD_CHANNEL_USUARIOS;
const CHANNEL_PAGAMENTOS = process.env.DISCORD_CHANNEL_PAGAMENTOS;
const CHANNEL_SAQUES     = process.env.DISCORD_CHANNEL_SAQUES;
const CHANNEL_COMISSOES  = process.env.DISCORD_CHANNEL_COMISSOES;
const CHANNEL_BANNERS    = process.env.DISCORD_CHANNEL_BANNERS;
const ADMIN_EMAIL        = (process.env.ADMIN_EMAIL || "").toLowerCase();
const SUPPORT_WHATSAPP_DEFAULT = String(process.env.SUPPORT_WHATSAPP || "553195738547").replace(/\D/g, "");

const discord_headers = {
  Authorization: `Bot ${BOT_TOKEN}`,
  "Content-Type": "application/json",
};

const channel_map = { usuarios: CHANNEL_USUARIOS, pagamentos: CHANNEL_PAGAMENTOS, saques: CHANNEL_SAQUES, comissoes: CHANNEL_COMISSOES, banners: CHANNEL_BANNERS };

async function discord_get(path) {
  const r = await fetch(`${DISCORD_API}${path}`, { headers: discord_headers });
  return r.json();
}

async function discord_post(path, body) {
  const r = await fetch(`${DISCORD_API}${path}`, { method: "POST", headers: discord_headers, body: JSON.stringify(body) });
  return r.json();
}

async function discord_patch(path, body) {
  const r = await fetch(`${DISCORD_API}${path}`, { method: "PATCH", headers: discord_headers, body: JSON.stringify(body) });
  return r.json();
}

async function discord_post_form(channel_id, form_data) {
  const r = await fetch(`${DISCORD_API}/channels/${channel_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
    body: form_data,
  });
  return r.json();
}

async function fetch_all_messages(channel_id) {
  let messages = [];
  let last_id = null;
  while (true) {
    const qs = last_id ? `?limit=100&before=${last_id}` : `?limit=100`;
    const batch = await discord_get(`/channels/${channel_id}/messages${qs}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    messages = messages.concat(batch);
    if (batch.length < 100) break;
    last_id = batch[batch.length - 1].id;
  }
  return messages;
}

async function find_user(email) {
  const messages = await fetch_all_messages(CHANNEL_USUARIOS);
  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.content);
      if (data.email === email.toLowerCase()) return { ...data, msg_id: msg.id };
    } catch {}
  }
  return null;
}

async function find_user_by_referral(code) {
  const messages = await fetch_all_messages(CHANNEL_USUARIOS);
  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.content);
      if (String(data.referral_code || "").toUpperCase() === String(code || "").toUpperCase()) return { ...data, msg_id: msg.id };
    } catch {}
  }
  return null;
}

const LOGIN_RE = /^[a-z0-9._-]{3,20}$/;
const norm_login = (value) => String(value || "").trim().toLowerCase().replace(/^@/, "");

async function find_user_by_login(login) {
  const target = norm_login(login);
  if (!LOGIN_RE.test(target)) return null;
  const messages = await fetch_all_messages(CHANNEL_USUARIOS);
  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.content);
      if (String(data.login || "").toLowerCase() === target) return { ...data, msg_id: msg.id };
    } catch {}
  }
  return null;
}

// aceita e-mail ou login
const find_account = (identifier) => String(identifier).includes("@") ? find_user(String(identifier).trim()) : find_user_by_login(identifier);

const shown_name = (entry) => entry.login || entry.name || String(entry.email || "").split("@")[0];

async function update_user(msg_id, data) {
  return discord_patch(`/channels/${CHANNEL_USUARIOS}/messages/${msg_id}`, { content: fit_content(data) });
}

function gen_referral_code(email) {
  const base = email.split("@")[0].replace(/[^a-z0-9]/gi, "").substring(0, 4).toUpperCase();
  return base + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function simple_hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// usuário dono do token enviado pelo site (null se inválido)
async function auth(body) {
  const session = read_token(body.token);
  if (!session) return null;
  const user = await find_user(session.email);
  if (!user || blocked_message(user)) return null;
  if (user.adm?.valid_after && session.issued_at < user.adm.valid_after) return null;
  return user;
}

function touch_access(user, context) {
  const now = new Date().toISOString();
  return { ...user, last: compact_context(context, now), login_count: (user.login_count || 0) + 1 };
}

const parse_material = (message) => {
  try { return JSON.parse(message.content) || {}; } catch { return {}; }
};


// notificações: tudo é calculado a partir dos registros que já existem (nada novo é gravado)
const sale_item = (message, email) => {
  try {
    const d = JSON.parse(message.content);
    if (!d || d.affiliate !== email || d.reverted) return null;
    return { id: `s${message.id}`, type: "sale", at: Date.parse(d.created_at) || snowflake_time(message.id), amount: d.amount, plan: d.plan };
  } catch { return null; }
};


const clean_text = (value, max) => String(value ?? "").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

// ao trocar o e-mail, o histórico (indicações, pagamentos, saques, comissões) acompanha a conta.
// É seguro repetir: cada registro só é alterado se ainda apontar para o e-mail antigo.
async function cascade_email(old_email, new_email, deadline) {
  const [users, payments, withdrawals, commissions] = await Promise.all(
    ["users", "payments", "withdrawals", "commissions"].map((key) => read_channel(key, { fresh: true })),
  );
  const jobs = [
    ...users.filter((row) => row.referred_by === old_email).map((row) => ["users", row, { referred_by: new_email }]),
    ...payments.filter((row) => row.email === old_email).map((row) => ["payments", row, { email: new_email }]),
    ...withdrawals.filter((row) => row.email === old_email).map((row) => ["withdrawals", row, { email: new_email }]),
    ...commissions.filter((row) => row.affiliate === old_email).map((row) => ["commissions", row, { affiliate: new_email }]),
    ...commissions.filter((row) => row.from_user === old_email).map((row) => ["commissions", row, { from_user: new_email }]),
  ];
  for (const [key, row, change] of jobs) {
    if (Date.now() > deadline) return false;
    const current = await get_row(key, row.msg_id);
    if (current) await patch_row(key, row.msg_id, { ...current, ...change });
  }
  invalidate();
  return true;
}

const public_user = (user, token) => {
  const { password_hash, msg_id, owner_doc, reg, last, login_count, adm, ...safe } = user;
  const staff_role = user.email === ADMIN_EMAIL ? "owner" : ["admin", "support", "finance"].includes(adm?.role) ? adm.role : null;
  return { ...safe, has_password: !!password_hash, is_admin: user.email === ADMIN_EMAIL, staff_role, ...(token ? { token } : {}) };
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  const { action, ...body } = req.body;

  if (action === "get_banners") {
    const messages = await fetch_all_messages(CHANNEL_BANNERS);
    const limit = body.all ? 50 : 10;
    const banners = messages
      .filter(m => m.attachments?.length > 0 && parse_material(m).kind !== "avatar")
      .slice(0, limit)
      .map(m => {
        const meta = parse_material(m);
        return { id: m.id, url: m.attachments[0].url, link: meta.link || null, title: meta.title || "", downloads: meta.downloads || 0, shares: meta.shares || 0 };
      })
      .reverse();
    return res.status(200).json({ banners });
  }

  if (action === "upload_banner") {
    const { email, password, image_base64, image_type, link, title } = body;
    const user = await find_user(email);
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "Acesso negado" });
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Apenas o administrador pode enviar banners" });

    const binary = Buffer.from(image_base64, "base64");
    const ext = image_type.split("/")[1] || "jpg";
    const filename = `banner_${Date.now()}.${ext}`;

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: JSON.stringify({ link: link || null, title: String(title || "").trim().slice(0, 80) || null, downloads: 0, shares: 0 }) }));
    form.append("files[0]", new Blob([binary], { type: image_type }), filename);

    const msg = await discord_post_form(CHANNEL_BANNERS, form);
    if (!msg.id) return res.status(500).json({ error: "Falha ao enviar banner" });
    return res.status(200).json({ ok: true, url: msg.attachments?.[0]?.url });
  }

  if (action === "delete_banner") {
    const { email, password, msg_id } = body;
    const user = await find_user(email);
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "Acesso negado" });
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Apenas o administrador pode excluir banners" });

    await fetch(`${DISCORD_API}/channels/${CHANNEL_BANNERS}/messages/${msg_id}`, {
      method: "DELETE",
      headers: discord_headers,
    });
    return res.status(200).json({ ok: true });
  }

  if (action === "get_videos") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const messages = await fetch_all_messages(CHANNEL_BANNERS);
    const videos = messages
      .map(m => ({ id: m.id, meta: parse_material(m) }))
      .filter(entry => entry.meta.kind === "video" && entry.meta.url)
      .slice(0, 50)
      .map(entry => ({ id: entry.id, title: entry.meta.title || "Vídeo", url: entry.meta.url, downloads: entry.meta.downloads || 0, shares: entry.meta.shares || 0, views: entry.meta.views || 0, created_at: entry.meta.created_at || null }));
    return res.status(200).json({ videos });
  }

  if (action === "add_video") {
    const { email, password, title, url } = body;
    const user = await find_user(String(email || ""));
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "Acesso negado" });
    if (String(email).toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Apenas o administrador pode publicar vídeos" });

    const clean_title = String(title || "").trim().slice(0, 80);
    const clean_url = String(url || "").trim();
    if (!clean_title) return res.status(400).json({ error: "Informe o título do vídeo" });
    if (!/^https:\/\/[^\s]+$/i.test(clean_url) || clean_url.length > 500) return res.status(400).json({ error: "Informe um link https válido" });

    const meta = { kind: "video", title: clean_title, url: clean_url, downloads: 0, shares: 0, created_at: new Date().toISOString() };
    const msg = await discord_post(`/channels/${CHANNEL_BANNERS}/messages`, { content: JSON.stringify(meta) });
    if (!msg.id) return res.status(500).json({ error: "Falha ao publicar vídeo" });
    return res.status(200).json({ ok: true, id: msg.id });
  }

  if (action === "track_material") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    if (!["downloads", "shares"].includes(body.metric)) return res.status(400).json({ error: "Métrica inválida" });
    if (!/^\d{5,25}$/.test(String(body.msg_id || ""))) return res.status(400).json({ error: "Material inválido" });

    const message = await discord_get(`/channels/${CHANNEL_BANNERS}/messages/${body.msg_id}`);
    if (!message?.id) return res.status(404).json({ error: "Material não encontrado" });
    const meta = parse_material(message);
    meta[body.metric] = (meta[body.metric] || 0) + 1;
    await discord_patch(`/channels/${CHANNEL_BANNERS}/messages/${message.id}`, { content: JSON.stringify(meta) });
    return res.status(200).json({ ok: true });
  }

  // página pública de divulgação: não exige login, só lê um vídeo já publicado
  if (action === "get_public_video") {
    const id = String(body.id || "");
    if (!/^\d{5,25}$/.test(id)) return res.status(200).json({ found: false });
    const message = await discord_get(`/channels/${CHANNEL_BANNERS}/messages/${id}`);
    const meta = message?.id ? parse_material(message) : {};
    if (meta.kind !== "video" || !meta.url) return res.status(200).json({ found: false });
    return res.status(200).json({ found: true, title: meta.title || "Vídeo", url: meta.url });
  }

  // conta um acesso na página de divulgação (guardado no próprio registro do vídeo)
  if (action === "track_video_view") {
    const id = String(body.id || "");
    if (!/^\d{5,25}$/.test(id)) return res.status(200).json({ ok: false });
    const message = await discord_get(`/channels/${CHANNEL_BANNERS}/messages/${id}`);
    const meta = message?.id ? parse_material(message) : {};
    if (meta.kind !== "video") return res.status(200).json({ ok: false });
    meta.views = (meta.views || 0) + 1;
    await discord_patch(`/channels/${CHANNEL_BANNERS}/messages/${message.id}`, { content: JSON.stringify(meta) });
    return res.status(200).json({ ok: true });
  }

  if (action === "get_inviter") {
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (code.length < 3) return res.status(200).json({ found: false });
    const messages = await fetch_all_messages(CHANNEL_USUARIOS);
    let inviter = null;
    const people = [];
    for (const message of messages) {
      try {
        const entry = JSON.parse(message.content);
        people.push(entry);
        if (String(entry.referral_code || "").toUpperCase() === code) inviter = entry;
      } catch {}
    }
    if (!inviter) return res.status(200).json({ found: false });
    const raw = String(inviter.login || inviter.name || inviter.email.split("@")[0]).replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
    const first = raw.split(/[ ._-]/)[0] || "Um amigo";
    const referred = people.filter(entry => entry.referred_by === inviter.email);
    return res.status(200).json({
      found: true,
      name: first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(),
      members: referred.length,
      active: referred.filter(entry => entry.plan).length,
      verified: !!inviter.plan,
    });
  }

  if (action === "set_referral_code") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4 || code.length > 12) return res.status(400).json({ error: "Use de 4 a 12 letras ou números." });
    if (code !== user.referral_code) {
      const taken = await find_user_by_referral(code);
      if (taken && taken.email !== user.email) return res.status(400).json({ error: "Esse código já está em uso. Escolha outro." });
    }
    const { msg_id, ...data } = user;
    const next = { ...data, referral_code: code };
    await update_user(msg_id, next);
    return res.status(200).json({ ok: true, user: public_user(next) });
  }

  // só as 100 mensagens mais recentes de comissões: barato o bastante para consultar a cada ~25s
  if (action === "poll_notifications") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const batch = await discord_get(`/channels/${CHANNEL_COMISSOES}/messages?limit=100`);
    const sales = Array.isArray(batch) ? batch.map((m) => sale_item(m, user.email)).filter(Boolean) : [];
    return res.status(200).json({ sales });
  }

  if (action === "get_notifications") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const [commission_messages, withdrawal_messages, user_messages, announcements] = await Promise.all([
      fetch_all_messages(CHANNEL_COMISSOES), fetch_all_messages(CHANNEL_SAQUES), fetch_all_messages(CHANNEL_USUARIOS),
      list_config("announcement").catch(() => []),
    ]);
    const items = [];
    for (const message of commission_messages) { const item = sale_item(message, user.email); if (item) items.push(item); }
    for (const message of withdrawal_messages) {
      try {
        const d = JSON.parse(message.content);
        if (d.email !== user.email) continue;
        items.push({ id: `w${message.id}`, type: "withdrawal", at: Date.parse(d.created_at) || snowflake_time(message.id), amount: d.amount, status: d.status });
      } catch {}
    }
    for (const message of user_messages) {
      try {
        const d = JSON.parse(message.content);
        if (d.referred_by !== user.email) continue;
        const raw = String(d.login || d.name || d.email.split("@")[0]).replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
        items.push({ id: `r${message.id}`, type: "referral", at: Date.parse(d.created_at) || snowflake_time(message.id), name: raw.split(/[ ._-]/)[0] || "Alguém" });
      } catch {}
    }
    for (const row of announcements) {
      if (row.target && row.target !== user.email) continue;
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) continue;
      items.push({ id: `a${row.msg_id}`, type: "notice", at: row.msg_at, title: row.title, text: row.text, level: row.level || "info" });
    }
    items.sort((a, b) => b.at - a.at);
    return res.status(200).json({ items: items.slice(0, 80) });
  }

  if (action === "get_config") {
    const settings = await get_settings();
    return res.status(200).json({ google_client_id: GOOGLE_CLIENT_ID || null, payouts: PAYOUTS_ENABLED, maintenance: settings.maintenance, maintenance_message: settings.maintenance_message, support_whatsapp: settings.support_whatsapp || SUPPORT_WHATSAPP_DEFAULT, chat_enabled: !!process.env.DISCORD_CHANNEL_SUPORTE });
  }

  if (action === "get_announcements") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const rows = await list_config("announcement");
    const active = rows.filter((row) => (!row.target || row.target === user.email) && (!row.expires_at || Date.parse(row.expires_at) > Date.now()));
    return res.status(200).json({ announcements: active.sort((a, b) => b.msg_at - a.msg_at).map((row) => ({ id: row.msg_id, title: row.title, text: row.text, level: row.level || "info", created_at: row.created_at })) });
  }

  if (action === "register") {
    const { password, referral_code } = body;
    const email = String(body.email || "").trim().toLowerCase();
    const whatsapp = norm_phone(body.whatsapp);
    const login = norm_login(body.login);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) return res.status(400).json({ error: "Dados inválidos" });
    if (!LOGIN_RE.test(login)) return res.status(400).json({ error: "Escolha um login de 3 a 20 caracteres (letras, números, ponto, hífen ou _)" });
    if (String(password).length < 6) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres" });
    if (!whatsapp) return res.status(400).json({ error: "Informe um WhatsApp válido com DDD" });
    const context = request_context(req, body.client);
    const gate_error = await check_signup(context, email);
    if (gate_error) return res.status(403).json({ error: gate_error });
    const existing = await find_user(email);
    if (existing) return res.status(400).json({ error: "E-mail já cadastrado" });
    if (await find_user_by_login(login)) return res.status(400).json({ error: "Esse login já está em uso. Escolha outro." });

    let referred_by = null;
    if (referral_code) {
      const referrer = await find_user_by_referral(referral_code);
      if (referrer) referred_by = referrer.email;
    }

    const user = {
      email,
      login,
      whatsapp,
      password_hash: hash_password(password),
      balance: 0,
      plan: null,
      plan_activated_at: null,
      referral_code: gen_referral_code(email),
      referred_by,
      created_at: new Date().toISOString(),
      reg: compact_context(context),
      last: compact_context(context),
      login_count: 1,
    };

    await discord_post(`/channels/${CHANNEL_USUARIOS}/messages`, { content: fit_content(user) });
    await log_event("signup", { email, method: "password", referred_by, created_at: user.created_at, ...log_context(context) });
    return res.status(200).json({ ok: true, user: public_user(user, make_token(email)) });
  }

  if (action === "login") {
    const { password } = body;
    const identifier = String(body.login || body.email || "").trim().toLowerCase();
    const context = request_context(req, body.client);
    const user = identifier ? await find_account(identifier) : null;
    const login_email = user?.email || identifier;
    const gate_error = await check_login(context, login_email);
    if (gate_error) return res.status(403).json({ error: gate_error });
    if (user && !user.password_hash) return res.status(401).json({ error: "Esta conta usa o Google. Toque em “Continuar com Google”." });
    if (!user || !verify_password(password, user.password_hash)) {
      await log_event("login_failed", { email: login_email, reason: user ? "senha" : "conta inexistente", ...log_context(context) });
      return res.status(401).json({ error: "Login/e-mail ou senha incorretos" });
    }
    const blocked = blocked_message(user);
    if (blocked) {
      await log_event("login_failed", { email: login_email, reason: "conta bloqueada", ...log_context(context) });
      return res.status(403).json({ error: blocked });
    }

    const { msg_id, ...current } = user;
    const upgraded = user.password_hash.startsWith("s1$") ? current : { ...current, password_hash: hash_password(password) };
    const next = touch_access(upgraded, context);
    await update_user(msg_id, next);
    await log_event("login", { email: user.email, method: "password", ...log_context(context) });
    return res.status(200).json({ ok: true, user: public_user(next, make_token(user.email)) });
  }

  // "Continuar com Google": cria a conta se for nova, entra se já existir
  if (action === "google_login") {
    const g = await verify_google(body.credential);
    if (!g) return res.status(401).json({ error: "Não foi possível validar o login com o Google" });

    const context = request_context(req, body.client);
    const gate_error = await check_login(context, g.email);
    if (gate_error) return res.status(403).json({ error: gate_error });

    let user = await find_user(g.email);
    let created = false;
    if (!user) {
      const signup_error = await check_signup(context, g.email);
      if (signup_error) return res.status(403).json({ error: signup_error });
      let referred_by = null;
      if (body.referral_code) {
        const referrer = await find_user_by_referral(body.referral_code);
        if (referrer) referred_by = referrer.email;
      }
      user = {
        email: g.email, whatsapp: null, password_hash: null, google: true, name: g.name,
        balance: 0, plan: null, plan_activated_at: null,
        referral_code: gen_referral_code(g.email), referred_by, created_at: new Date().toISOString(),
        reg: compact_context(context), last: compact_context(context), login_count: 1,
      };
      await discord_post(`/channels/${CHANNEL_USUARIOS}/messages`, { content: fit_content(user) });
      await log_event("signup", { email: g.email, method: "google", referred_by, created_at: user.created_at, ...log_context(context) });
      created = true;
    } else {
      const blocked = blocked_message(user);
      if (blocked) {
        await log_event("login_failed", { email: g.email, reason: "conta bloqueada", ...log_context(context) });
        return res.status(403).json({ error: blocked });
      }
      const { msg_id, ...current } = user;
      user = touch_access(current, context);
      await update_user(msg_id, user);
      await log_event("login", { email: g.email, method: "google", ...log_context(context) });
    }
    return res.status(200).json({ ok: true, created, user: public_user(user, make_token(g.email)) });
  }

  if (action === "change_password") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const { current_password, new_password } = body;
    if (String(new_password || "").length < 6) return res.status(400).json({ error: "A nova senha precisa ter pelo menos 6 caracteres" });
    if (user.password_hash && !verify_password(String(current_password || ""), user.password_hash)) return res.status(403).json({ error: "Senha atual incorreta" });
    const { msg_id, ...data } = user;
    await update_user(msg_id, { ...data, password_hash: hash_password(new_password) });
    await log_event("password_change", { email: user.email, ...log_context(request_context(req, body.client)) });
    return res.status(200).json({ ok: true });
  }

  if (action === "get_affiliates") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const [user_messages, commission_messages] = await Promise.all([fetch_all_messages(CHANNEL_USUARIOS), fetch_all_messages(CHANNEL_COMISSOES)]);
    const earned = {};
    for (const message of commission_messages) {
      try {
        const entry = JSON.parse(message.content);
        if (entry.affiliate === user.email && !entry.reverted) earned[entry.from_user] = (earned[entry.from_user] || 0) + entry.amount;
      } catch {}
    }
    const mask_email = (email) => `${email.split("@")[0].slice(0, 2)}***@${email.split("@")[1]}`;
    const affiliates = [];
    for (const message of user_messages) {
      try {
        const entry = JSON.parse(message.content);
        if (entry.referred_by !== user.email) continue;
        affiliates.push({ name: shown_name(entry), login: entry.login || null, avatar: entry.avatar || null, email: mask_email(entry.email), whatsapp: entry.whatsapp || null, plan: entry.plan || null, created_at: entry.created_at || null, plan_activated_at: entry.plan_activated_at || null, earned: Number((earned[entry.email] || 0).toFixed(2)) });
      } catch {}
    }
    affiliates.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    return res.status(200).json({ affiliates });
  }

  if (action === "set_login") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const login = norm_login(body.login);
    if (!LOGIN_RE.test(login)) return res.status(400).json({ error: "Use de 3 a 20 caracteres: letras, números, ponto, hífen ou _" });
    if (login !== user.login) {
      const taken = await find_user_by_login(login);
      if (taken && taken.email !== user.email) return res.status(400).json({ error: "Esse login já está em uso. Escolha outro." });
    }
    const { msg_id, ...data } = user;
    const next = { ...data, login };
    await update_user(msg_id, next);
    if (login !== user.login) await log_event("profile_update", { email: user.email, fields: ["login"], ...log_context(request_context(req, body.client)) });
    return res.status(200).json({ ok: true, user: public_user(next) });
  }

  if (action === "get_user") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    return res.status(200).json({ user: public_user(user) });
  }

  // WhatsApp, chave Pix salva e opção de receber comissões direto no Pix
  if (action === "update_profile") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const { msg_id, ...data } = user;
    const next = { ...data };

    if (body.whatsapp !== undefined) {
      const w = norm_phone(body.whatsapp);
      if (!w) return res.status(400).json({ error: "Informe um WhatsApp válido com DDD" });
      next.whatsapp = w;
    }

    if (body.pix_key !== undefined) {
      const type = PIX_TYPES[String(body.pix_type || "").toLowerCase()];
      if (!type) return res.status(400).json({ error: "Tipo de chave Pix inválido" });
      if (!valid_pix_key(type, body.pix_key)) return res.status(400).json({ error: "Chave Pix inválida para o tipo escolhido" });
      const key = normalize_pix_key(type, body.pix_key);
      // o Mercado Pago exige o documento do titular da chave
      const owner_doc = type === "CPF" || type === "CNPJ" ? key : only_digits(body.owner_doc);
      if (!valid_doc(owner_doc)) return res.status(400).json({ error: "Informe o CPF do titular da chave Pix" });
      next.pix_key = key; next.pix_type = type; next.owner_doc = owner_doc;
    }

    if (body.auto_payout !== undefined) {
      if (body.auto_payout && !(next.pix_key)) return res.status(400).json({ error: "Salve uma chave Pix antes de ativar o recebimento automático" });
      next.auto_payout = !!body.auto_payout;
    }

    if (body.name !== undefined) {
      const name = clean_text(body.name, 60);
      if (name.length < 2) return res.status(400).json({ error: "Informe seu nome (mínimo 2 letras)" });
      next.name = name;
    }
    if (body.city !== undefined) {
      const city = clean_text(body.city, 40);
      if (city) next.city = city; else delete next.city;
    }
    if (body.bio !== undefined) {
      const bio = clean_text(body.bio, 100);
      if (bio) next.bio = bio; else delete next.bio;
    }
    if (body.birth !== undefined) {
      const birth = String(body.birth || "").trim();
      if (!birth) delete next.birth;
      else {
        const time = Date.parse(`${birth}T12:00:00Z`);
        const age = (Date.now() - time) / 31557600000;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(time) || age < 13 || age > 110) return res.status(400).json({ error: "Data de nascimento inválida" });
        next.birth = birth;
      }
    }

    try { fit_content(next); } catch { return res.status(400).json({ error: "Os dados do perfil ficaram grandes demais. Encurte algum campo." }); }
    await update_user(msg_id, next);
    const changed = Object.keys(next).filter((key) => ["name", "city", "bio", "birth", "whatsapp", "pix_key", "auto_payout"].includes(key) && next[key] !== data[key]);
    if (changed.length) await log_event("profile_update", { email: user.email, fields: changed, ...log_context(request_context(req, body.client)) });
    return res.status(200).json({ ok: true, user: public_user(next) });
  }

  if (action === "change_email") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const old_email = user.email;
    const new_email = String(body.new_email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email)) return res.status(400).json({ error: "Informe um e-mail válido" });
    if (new_email === old_email) return res.status(400).json({ error: "O novo e-mail é igual ao atual" });
    if (old_email === ADMIN_EMAIL) return res.status(403).json({ error: "O e-mail do dono do site é definido na variável ADMIN_EMAIL da Vercel. Troque lá e depois aqui." });
    if (new_email === ADMIN_EMAIL) return res.status(403).json({ error: "Este e-mail não pode ser utilizado." });
    if (user.google) return res.status(403).json({ error: "Sua conta entra pelo Google e usa o e-mail do Google. Fale com o suporte para trocar." });
    if (!user.password_hash || !verify_password(String(body.password || ""), user.password_hash)) return res.status(403).json({ error: "Senha incorreta" });

    const blocklist = await get_blocklist();
    if (blocklist.emails.includes(new_email) || blocklist.domains.includes(new_email.split("@")[1])) return res.status(403).json({ error: "Este e-mail não pode ser utilizado." });
    if (await find_user(new_email)) return res.status(400).json({ error: "Já existe uma conta com esse e-mail" });

    // um Pix ainda aguardando pagamento ficaria preso ao e-mail antigo
    const payments = await read_channel("payments", { fresh: true });
    if (payments.some((row) => row.email === old_email && row.status === "pending" && Date.now() - Date.parse(row.created_at || 0) < 90 * 60 * 1000)) {
      return res.status(409).json({ error: "Você tem um Pix aguardando pagamento. Conclua ou espere ele expirar e tente de novo." });
    }

    const finished = await cascade_email(old_email, new_email, Date.now() + 7000);
    if (!finished) return res.status(503).json({ error: "Demorou mais que o esperado. Tente de novo: nada se perde e continua de onde parou." });

    const { msg_id, ...data } = user;
    const next = { ...data, email: new_email, adm: { ...(data.adm || {}), valid_after: Date.now() } };
    await update_user(msg_id, next);
    invalidate();
    await log_event("email_change", { email: new_email, from: old_email, to: new_email, ...log_context(request_context(req, body.client)) });
    return res.status(200).json({ ok: true, user: public_user(next, make_token(new_email)) });
  }

  if (action === "upload_avatar") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const b64 = String(body.image_base64 || "").replace(/^data:[^,]+,/, "");
    if (!b64 || b64.length > 700000) return res.status(400).json({ error: "Imagem muito grande" });
    const binary = Buffer.from(b64, "base64");
    if (binary.length < 200 || binary.length > 500000 || !(binary[0] === 0xff && binary[1] === 0xd8 && binary[2] === 0xff)) return res.status(400).json({ error: "Envie uma imagem JPG ou PNG válida" });

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: JSON.stringify({ kind: "avatar", owner: user.email, at: new Date().toISOString() }) }));
    form.append("files[0]", new Blob([binary], { type: "image/jpeg" }), `avatar_${Date.now()}.jpg`);
    const posted = await discord_post_form(CHANNEL_BANNERS, form);
    if (!posted.id) return res.status(500).json({ error: "Não foi possível salvar a foto agora" });

    const { msg_id, ...data } = user;
    const previous = data.avatar;
    const next = { ...data, avatar: posted.id };
    await update_user(msg_id, next);
    if (previous) await fetch(`${DISCORD_API}/channels/${CHANNEL_BANNERS}/messages/${previous}`, { method: "DELETE", headers: discord_headers }).catch(() => {});
    await log_event("avatar_update", { email: user.email, avatar: posted.id });
    return res.status(200).json({ ok: true, user: public_user(next) });
  }

  if (action === "remove_avatar") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const { msg_id, ...data } = user;
    const previous = data.avatar;
    const next = { ...data };
    delete next.avatar;
    await update_user(msg_id, next);
    if (previous) await fetch(`${DISCORD_API}/channels/${CHANNEL_BANNERS}/messages/${previous}`, { method: "DELETE", headers: discord_headers }).catch(() => {});
    await log_event("avatar_update", { email: user.email, avatar: null });
    return res.status(200).json({ ok: true, user: public_user(next) });
  }

  if (action === "get_commissions") {
    const me = await auth(body);
    if (!me) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const email = me.email;
    const messages = await fetch_all_messages(CHANNEL_COMISSOES);
    const commissions = messages.reduce((acc, msg) => {
      try { const d = JSON.parse(msg.content); if (d.affiliate === email) acc.push(d); } catch {}
      return acc;
    }, []);
    return res.status(200).json({ commissions });
  }

  if (action === "get_withdrawals") {
    const me = await auth(body);
    if (!me) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const email = me.email;
    const messages = await fetch_all_messages(CHANNEL_SAQUES);
    const withdrawals = messages.reduce((acc, msg) => {
      try { const d = JSON.parse(msg.content); if (d.email === email) acc.push({ ...d, msg_id: msg.id }); } catch {}
      return acc;
    }, []);
    return res.status(200).json({ withdrawals });
  }

  if (action === "request_withdrawal") {
    const user = await auth(body);
    if (!user) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });

    const settings = await get_settings();
    if (!settings.withdrawals_open) return res.status(403).json({ error: "Os saques estão temporariamente pausados." });
    if (user.adm?.withdraw_blocked) return res.status(403).json({ error: "Saques bloqueados para esta conta. Fale com o suporte." });

    const amount = Number(body.amount);
    if (!(amount > 0) || amount > (user.balance || 0)) return res.status(400).json({ error: "Saldo insuficiente" });
    if (amount < Math.max(1, settings.min_withdraw)) return res.status(400).json({ error: `O valor mínimo de saque é R$ ${Math.max(1, settings.min_withdraw).toFixed(2).replace(".", ",")}` });
    if (settings.max_withdraw > 0 && amount > settings.max_withdraw) return res.status(400).json({ error: `O valor máximo por saque é R$ ${settings.max_withdraw.toFixed(2).replace(".", ",")}` });

    // usa a chave enviada ou a salva no perfil
    const type = PIX_TYPES[String(body.pix_type || user.pix_type || "").toLowerCase()];
    const raw_key = body.pix_key || user.pix_key;
    if (!type || !valid_pix_key(type, raw_key)) return res.status(400).json({ error: "Chave Pix inválida" });
    const key = normalize_pix_key(type, raw_key);
    const owner_doc = type === "CPF" || type === "CNPJ" ? key : only_digits(body.owner_doc || user.owner_doc);
    if (!valid_doc(owner_doc)) return res.status(400).json({ error: "Informe o CPF do titular da chave Pix" });

    try {
      const r = await process_withdrawal({ email: user.email, amount, key, type, owner_doc, source: "user" });
      return res.status(200).json({ ok: true, status: r.status });
    } catch (e) {
      if (e instanceof MpError) return res.status(e.status >= 400 && e.status < 600 ? e.status : 400).json({ error: e.message });
      throw e;
    }
  }

  if (action === "admin_get_all") {
    const { email, password } = body;
    const user = await find_user(email);
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "Acesso negado" });
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Acesso negado" });

    const [user_msgs, payment_msgs, withdrawal_msgs, commission_msgs] = await Promise.all([
      fetch_all_messages(CHANNEL_USUARIOS),
      fetch_all_messages(CHANNEL_PAGAMENTOS),
      fetch_all_messages(CHANNEL_SAQUES),
      fetch_all_messages(CHANNEL_COMISSOES),
    ]);

    const parse = (msgs) => msgs.reduce((acc, msg) => {
      try { acc.push({ ...JSON.parse(msg.content), msg_id: msg.id }); } catch {}
      return acc;
    }, []);

    return res.status(200).json({
      users: parse(user_msgs).map(({ password_hash, ...u }) => u),
      payments: parse(payment_msgs),
      withdrawals: parse(withdrawal_msgs),
      commissions: parse(commission_msgs),
    });
  }

  if (action === "admin_update_withdrawal") {
    const { email, password, msg_id, status, transfer_id } = body;
    const user = await find_user(email);
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "Acesso negado" });
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Acesso negado" });

    const messages = await fetch_all_messages(CHANNEL_SAQUES);
    const target = messages.find(m => m.id === msg_id);
    if (!target) return res.status(404).json({ error: "Saque não encontrado" });

    const data = JSON.parse(target.content);
    await discord_patch(`/channels/${CHANNEL_SAQUES}/messages/${msg_id}`, {
      content: JSON.stringify({ ...data, status, ...(transfer_id ? { transfer_id } : {}) }),
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Ação desconhecida" });
}
