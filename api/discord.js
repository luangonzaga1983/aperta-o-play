export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

import { fit_content, get_settings, get_config, list_config, log_event } from "../lib/store.js";
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
      if (data.referral_code === code) return { ...data, msg_id: msg.id };
    } catch {}
  }
  return null;
}

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
    const banners = messages
      .filter(m => m.attachments?.length > 0)
      .slice(0, 10)
      .map(m => ({
        id: m.id,
        url: m.attachments[0].url,
        link: (() => { try { return JSON.parse(m.content).link || null; } catch { return null; } })(),
      }))
      .reverse();
    return res.status(200).json({ banners });
  }

  if (action === "upload_banner") {
    const { email, password, image_base64, image_type, link } = body;
    const user = await find_user(email);
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "Acesso negado" });
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Apenas o administrador pode enviar banners" });

    const binary = Buffer.from(image_base64, "base64");
    const ext = image_type.split("/")[1] || "jpg";
    const filename = `banner_${Date.now()}.${ext}`;

    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: JSON.stringify({ link: link || null }) }));
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

  if (action === "get_config") {
    const settings = await get_settings();
    return res.status(200).json({ google_client_id: GOOGLE_CLIENT_ID || null, payouts: PAYOUTS_ENABLED, maintenance: settings.maintenance, maintenance_message: settings.maintenance_message, support_whatsapp: settings.support_whatsapp });
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) return res.status(400).json({ error: "Dados inválidos" });
    if (String(password).length < 6) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres" });
    if (!whatsapp) return res.status(400).json({ error: "Informe um WhatsApp válido com DDD" });
    const context = request_context(req, body.client);
    const gate_error = await check_signup(context, email);
    if (gate_error) return res.status(403).json({ error: gate_error });
    const existing = await find_user(email);
    if (existing) return res.status(400).json({ error: "E-mail já cadastrado" });

    let referred_by = null;
    if (referral_code) {
      const referrer = await find_user_by_referral(referral_code);
      if (referrer) referred_by = referrer.email;
    }

    const user = {
      email,
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
    const login_email = String(body.email || "").trim().toLowerCase();
    const context = request_context(req, body.client);
    const gate_error = await check_login(context, login_email);
    if (gate_error) return res.status(403).json({ error: gate_error });
    const user = await find_user(login_email);
    if (user && !user.password_hash) return res.status(401).json({ error: "Esta conta usa o Google. Toque em “Continuar com Google”." });
    if (!user || !verify_password(password, user.password_hash)) {
      await log_event("login_failed", { email: login_email, reason: user ? "senha" : "conta inexistente", ...log_context(context) });
      return res.status(401).json({ error: "E-mail ou senha incorretos" });
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
        affiliates.push({ name: entry.name || entry.email.split("@")[0], email: mask_email(entry.email), whatsapp: entry.whatsapp || null, plan: entry.plan || null, created_at: entry.created_at || null, plan_activated_at: entry.plan_activated_at || null, earned: Number((earned[entry.email] || 0).toFixed(2)) });
      } catch {}
    }
    affiliates.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    return res.status(200).json({ affiliates });
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

    await update_user(msg_id, next);
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
