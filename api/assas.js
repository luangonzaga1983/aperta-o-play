export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

const ASSAS_API   = "https://api.asaas.com/v3";
const ASSAS_TOKEN = process.env.ASSAS_TOKEN;
const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();

const CHANNEL_PAGAMENTOS = process.env.DISCORD_CHANNEL_PAGAMENTOS;
const CHANNEL_USUARIOS   = process.env.DISCORD_CHANNEL_USUARIOS;
const CHANNEL_COMISSOES  = process.env.DISCORD_CHANNEL_COMISSOES;
const DISCORD_API = "https://discord.com/api/v10";

const discord_headers = { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" };
const assas_headers   = { access_token: ASSAS_TOKEN, "Content-Type": "application/json" };

const PLANS = [
  { price: 25,  commission: 10 },
  { price: 50,  commission: 25 },
  { price: 100, commission: 50 },
];

async function assas_post(path, body) {
  const r = await fetch(`${ASSAS_API}${path}`, { method: "POST", headers: assas_headers, body: JSON.stringify(body) });
  return r.json();
}

async function assas_get(path) {
  const r = await fetch(`${ASSAS_API}${path}`, { headers: assas_headers });
  return r.json();
}

async function discord_get(path) {
  const r = await fetch(`${DISCORD_API}${path}`, { headers: discord_headers });
  return r.json();
}

async function discord_post(channel_id, content) {
  await fetch(`${DISCORD_API}/channels/${channel_id}/messages`, {
    method: "POST", headers: discord_headers, body: JSON.stringify({ content }),
  });
}

async function discord_patch(channel_id, msg_id, content) {
  await fetch(`${DISCORD_API}/channels/${channel_id}/messages/${msg_id}`, {
    method: "PATCH", headers: discord_headers, body: JSON.stringify({ content }),
  });
}

async function fetch_all_messages(channel_id) {
  let messages = [];
  let last_id = null;
  while (true) {
    const qs = last_id ? `?limit=100&before=${last_id}` : `?limit=100`;
    const r = await fetch(`${DISCORD_API}/channels/${channel_id}/messages${qs}`, { headers: discord_headers });
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    messages = messages.concat(batch);
    if (batch.length < 100) break;
    last_id = batch[batch.length - 1].id;
  }
  return messages;
}

async function find_user_by_email(email) {
  const messages = await fetch_all_messages(CHANNEL_USUARIOS);
  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.content);
      if (data.email === email.toLowerCase()) return { ...data, msg_id: msg.id };
    } catch {}
  }
  return null;
}

async function find_user_by_referral(email) {
  const user = await find_user_by_email(email);
  if (!user?.referred_by) return null;
  return find_user_by_email(user.referred_by);
}

async function activate_user_plan(email, plan_price) {
  const user = await find_user_by_email(email);
  if (!user) return;
  const { msg_id, ...clean } = user;
  await fetch(`${DISCORD_API}/channels/${CHANNEL_USUARIOS}/messages/${msg_id}`, {
    method: "PATCH", headers: discord_headers,
    body: JSON.stringify({ content: JSON.stringify({ ...clean, plan: plan_price, plan_activated_at: new Date().toISOString() }) }),
  });

  const referrer = await find_user_by_referral(email);
  if (!referrer) return;
  const plan = PLANS.find(p => p.price === plan_price);
  if (!plan) return;

  const { msg_id: ref_msg_id, ...ref_clean } = referrer;
  await fetch(`${DISCORD_API}/channels/${CHANNEL_USUARIOS}/messages/${ref_msg_id}`, {
    method: "PATCH", headers: discord_headers,
    body: JSON.stringify({ content: JSON.stringify({ ...ref_clean, balance: (referrer.balance || 0) + plan.commission }) }),
  });

  await discord_post(CHANNEL_COMISSOES, JSON.stringify({
    affiliate: referrer.email,
    from_user: email,
    amount: plan.commission,
    plan: plan_price,
    created_at: new Date().toISOString(),
  }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  const { action, ...body } = req.body;

  if (action === "create_pix") {
    const { email, plan_price } = body;
    const plan = PLANS.find(p => p.price === plan_price);
    if (!plan) return res.status(400).json({ error: "Plano inválido" });

    const customer = await assas_post("/customers", {
      name: email.split("@")[0],
      email,
    });

    const charge = await assas_post("/payments", {
      customer: customer.id,
      billingType: "PIX",
      value: plan.price,
      dueDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10),
      description: `Aperta o Play - Plano R$${plan.price}`,
    });

    const qr = await assas_get(`/payments/${charge.id}/pixQrCode`);

    await discord_post(CHANNEL_PAGAMENTOS, JSON.stringify({
      email, plan_price, assas_id: charge.id, status: "pending", created_at: new Date().toISOString(),
    }));

    return res.status(200).json({ assas_id: charge.id, qr_code: qr.payload, qr_base64: qr.encodedImage, amount: plan.price });
  }

  if (action === "check_payment") {
    const { assas_id, email } = body;
    const payment = await assas_get(`/payments/${assas_id}`);
    if (payment.status === "RECEIVED" || payment.status === "CONFIRMED") {
      const messages = await fetch_all_messages(CHANNEL_PAGAMENTOS);
      for (const msg of messages) {
        try {
          const data = JSON.parse(msg.content);
          if (data.assas_id === assas_id && data.status !== "approved") {
            await discord_patch(CHANNEL_PAGAMENTOS, msg.id, JSON.stringify({ ...data, status: "approved" }));
            await activate_user_plan(email, data.plan_price);
            break;
          }
        } catch {}
      }
      return res.status(200).json({ status: "approved" });
    }
    return res.status(200).json({ status: payment.status });
  }

  if (action === "create_withdrawal_pix") {
    const { email, password, amount, pix_key, pix_type } = body;
    if (email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: "Acesso negado" });

    const transfer = await assas_post("/transfers", {
      value: amount,
      bankAccount: {
        pixAddressKey: pix_key,
        pixAddressKeyType: pix_type.toUpperCase(),
      },
      operationType: "PIX",
      description: `Saque Aperta o Play`,
    });

    return res.status(200).json({ transfer_id: transfer.id, status: transfer.status });
  }

  return res.status(400).json({ error: "Ação desconhecida" });
}
