export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

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
    if (!user || user.password_hash !== simple_hash(password)) return res.status(401).json({ error: "Acesso negado" });
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
    if (!user || user.password_hash !== simple_hash(password)) return res.status(401).json({ error: "Acesso negado" });
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Apenas o administrador pode excluir banners" });

    await fetch(`${DISCORD_API}/channels/${CHANNEL_BANNERS}/messages/${msg_id}`, {
      method: "DELETE",
      headers: discord_headers,
    });
    return res.status(200).json({ ok: true });
  }

  if (action === "register") {
    const { email, password, referral_code } = body;
    if (!email || !password) return res.status(400).json({ error: "Dados inválidos" });
    const existing = await find_user(email);
    if (existing) return res.status(400).json({ error: "E-mail já cadastrado" });

    let referred_by = null;
    if (referral_code) {
      const referrer = await find_user_by_referral(referral_code);
      if (referrer) referred_by = referrer.email;
    }

    const user = {
      email: email.toLowerCase(),
      password_hash: simple_hash(password),
      balance: 0,
      plan: null,
      plan_activated_at: null,
      referral_code: gen_referral_code(email),
      referred_by,
      created_at: new Date().toISOString(),
    };

    await discord_post(`/channels/${CHANNEL_USUARIOS}/messages`, { content: JSON.stringify(user) });
    const { password_hash, ...safe } = user;
    const is_admin = user.email === ADMIN_EMAIL;
    return res.status(200).json({ ok: true, user: { ...safe, is_admin } });
  }

  if (action === "login") {
    const { email, password } = body;
    const user = await find_user(email);
    if (!user || user.password_hash !== simple_hash(password)) return res.status(401).json({ error: "E-mail ou senha incorretos" });
    const { password_hash, msg_id, ...safe } = user;
    return res.status(200).json({ ok: true, user: { ...safe, is_admin: user.email === ADMIN_EMAIL } });
  }

  if (action === "get_user") {
    const { email } = body;
    const user = await find_user(email);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const { password_hash, msg_id, ...safe } = user;
    return res.status(200).json({ user: { ...safe, is_admin: user.email === ADMIN_EMAIL } });
  }

  if (action === "get_commissions") {
    const { email } = body;
    const messages = await fetch_all_messages(CHANNEL_COMISSOES);
    const commissions = messages.reduce((acc, msg) => {
      try { const d = JSON.parse(msg.content); if (d.affiliate === email) acc.push(d); } catch {}
      return acc;
    }, []);
    return res.status(200).json({ commissions });
  }

  if (action === "get_withdrawals") {
    const { email } = body;
    const messages = await fetch_all_messages(CHANNEL_SAQUES);
    const withdrawals = messages.reduce((acc, msg) => {
      try { const d = JSON.parse(msg.content); if (d.email === email) acc.push({ ...d, msg_id: msg.id }); } catch {}
      return acc;
    }, []);
    return res.status(200).json({ withdrawals });
  }

  if (action === "request_withdrawal") {
    const { email, amount, pix_key, pix_type } = body;
    const user = await find_user(email);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (user.balance < amount || amount <= 0) return res.status(400).json({ error: "Saldo insuficiente" });

    const { msg_id, ...user_data } = user;
    await update_user(msg_id, { ...user_data, balance: user.balance - amount });
    await discord_post(`/channels/${CHANNEL_SAQUES}/messages`, {
      content: JSON.stringify({ email, amount, pix_key, pix_type, status: "pending", created_at: new Date().toISOString() }),
    });
    return res.status(200).json({ ok: true });
  }

  if (action === "admin_get_all") {
    const { email, password } = body;
    const user = await find_user(email);
    if (!user || user.password_hash !== simple_hash(password)) return res.status(401).json({ error: "Acesso negado" });
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
    if (!user || user.password_hash !== simple_hash(password)) return res.status(401).json({ error: "Acesso negado" });
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
