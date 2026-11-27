export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

import {
  make_token, verify_token, hash_password, verify_password, verify_google, GOOGLE_CLIENT_ID,
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
  const { msg_id: _, ...clean } = data;
  return discord_patch(`/channels/${CHANNEL_USUARIOS}/messages/${msg_id}`, { content: JSON.stringify(clean) });
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
  const email = verify_token(body.token);
  return email ? find_user(email) : null;
}

const public_user = (user, token) => {
  const { password_hash, msg_id, owner_doc, ...safe } = user;
  return { ...safe, has_password: !!password_hash, is_admin: user.email === ADMIN_EMAIL, ...(token ? { token } : {}) };
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
    return res.status(200).json({ google_client_id: GOOGLE_CLIENT_ID || null, payouts: PAYOUTS_ENABLED });
  }

  if (action === "register") {
    const { password, referral_code } = body;
    const email = String(body.email || "").trim().toLowerCase();
    const whatsapp = norm_phone(body.whatsapp);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) return res.status(400).json({ error: "Dados inválidos" });
    if (String(password).length < 6) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres" });
    if (!whatsapp) return res.status(400).json({ error: "Informe um WhatsApp válido com DDD" });
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
    };

    await discord_post(`/channels/${CHANNEL_USUARIOS}/messages`, { content: JSON.stringify(user) });
    return res.status(200).json({ ok: true, user: public_user(user, make_token(email)) });
  }

  if (action === "login") {
    const { password } = body;
    const user = await find_user(String(body.email || "").trim().toLowerCase());
    if (user && !user.password_hash) return res.status(401).json({ error: "Esta conta usa o Google. Toque em “Continuar com Google”." });
    if (!user || !verify_password(password, user.password_hash)) return res.status(401).json({ error: "E-mail ou senha incorretos" });

    // atualiza hash antigo (simple_hash) para scrypt no primeiro login
    if (!user.password_hash.startsWith("s1$")) {
      const { msg_id, ...d } = user;
      await update_user(msg_id, { ...d, password_hash: hash_password(password) });
    }
    return res.status(200).json({ ok: true, user: public_user(user, make_token(user.email)) });
  }

  // "Continuar com Google": cria a conta se for nova, entra se já existir
  if (action === "google_login") {
    const g = await verify_google(body.credential);
    if (!g) return res.status(401).json({ error: "Não foi possível validar o login com o Google" });

    let user = await find_user(g.email);
    let created = false;
    if (!user) {
      let referred_by = null;
      if (body.referral_code) {
        const referrer = await find_user_by_referral(body.referral_code);
        if (referrer) referred_by = referrer.email;
      }
      user = {
        email: g.email, whatsapp: null, password_hash: null, google: true, name: g.name,
        balance: 0, plan: null, plan_activated_at: null,
        referral_code: gen_referral_code(g.email), referred_by, created_at: new Date().toISOString(),
      };
      await discord_post(`/channels/${CHANNEL_USUARIOS}/messages`, { content: JSON.stringify(user) });
      created = true;
    }
    return res.status(200).json({ ok: true, created, user: public_user(user, make_token(g.email)) });
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
    const me = verify_token(body.token);
    if (!me) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const email = me;
    const messages = await fetch_all_messages(CHANNEL_COMISSOES);
    const commissions = messages.reduce((acc, msg) => {
      try { const d = JSON.parse(msg.content); if (d.affiliate === email) acc.push(d); } catch {}
      return acc;
    }, []);
    return res.status(200).json({ commissions });
  }

  if (action === "get_withdrawals") {
    const me = verify_token(body.token);
    if (!me) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });
    const email = me;
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

    const amount = Number(body.amount);
    if (!(amount > 0) || amount > (user.balance || 0)) return res.status(400).json({ error: "Saldo insuficiente" });
    if (amount < 1) return res.status(400).json({ error: "O valor mínimo de saque é R$ 1,00" });

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
