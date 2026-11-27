// Cliente Mercado Pago + regras de pagamento compartilhadas entre /api/pay e /api/mp-webhook.
// Docs: https://www.mercadopago.com.br/developers
//
// Única variável obrigatória: MP_ACCESS_TOKEN (Vercel > Settings > Environment Variables).

import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim().replace(/^["']|["']$/g, "");
const MP_API = "https://api.mercadopago.com";

const DISCORD_API = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const CHANNEL_USUARIOS   = process.env.DISCORD_CHANNEL_USUARIOS;
export const CHANNEL_PAGAMENTOS = process.env.DISCORD_CHANNEL_PAGAMENTOS;
export const CHANNEL_COMISSOES  = process.env.DISCORD_CHANNEL_COMISSOES;
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();

export const PLANS = [
  { price: 25,  commission: 10 },
  { price: 50,  commission: 25 },
  { price: 100, commission: 50 },
];

export class MpError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// ---------- Mercado Pago ----------

export async function mp(method, path, body, extra_headers = {}) {
  if (!ACCESS_TOKEN) throw new MpError("Access Token do Mercado Pago não configurado (MP_ACCESS_TOKEN).", 500, "no_token");

  let r;
  try {
    r = await fetch(`${MP_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        ...(method === "POST" ? { "X-Idempotency-Key": randomUUID() } : {}), // obrigatório nos POSTs
        ...extra_headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new MpError("Não foi possível conectar ao Mercado Pago. Tente novamente.", 502, "network");
  }

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* sem JSON */ }

  if (!r.ok) {
    const cause = data?.cause?.[0];
    const code = String(cause?.code ?? data?.error ?? `http_${r.status}`);
    let msg = cause?.description || data?.message || `Erro ${r.status} no Mercado Pago`;
    if (r.status === 401) msg = "Access Token do Mercado Pago inválido. Confira MP_ACCESS_TOKEN (use o token de PRODUÇÃO, que começa com APP_USR-).";
    console.error("[mp]", method, path, r.status, JSON.stringify(data));
    throw new MpError(msg, r.status, code);
  }
  return data;
}

// ---------- validações ----------

export const only_digits = (s) => String(s || "").replace(/\D/g, "");

export function valid_cpf(v) {
  const c = only_digits(v);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const t of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(c[i]) * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

export function valid_cnpj(v) {
  const c = only_digits(v);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  for (const t of [12, 13]) {
    let sum = 0, w = t - 7;
    for (let i = 0; i < t; i++) { sum += Number(c[i]) * w--; if (w < 2) w = 9; }
    if (((sum % 11) < 2 ? 0 : 11 - (sum % 11)) !== Number(c[t])) return false;
  }
  return true;
}

export const valid_doc = (v) => valid_cpf(v) || valid_cnpj(v);

// ---------- cobrança Pix ----------

export async function create_pix_payment({ email, plan, name, cpf_cnpj, notification_url }) {
  const doc = only_digits(cpf_cnpj);
  const [first_name, ...rest] = (name || email.split("@")[0]).trim().split(/\s+/);

  const payment = await mp("POST", "/v1/payments", {
    transaction_amount: Number(plan.price.toFixed(2)),
    payment_method_id: "pix",
    description: `Aperta o Play - Plano R$${plan.price}`,
    external_reference: `${email}|${plan.price}`,
    ...(notification_url ? { notification_url } : {}),
    payer: {
      email,
      first_name,
      last_name: rest.join(" ") || first_name,
      identification: { type: doc.length === 14 ? "CNPJ" : "CPF", number: doc },
    },
  });

  const td = payment?.point_of_interaction?.transaction_data;
  if (!payment?.id || !td?.qr_code) {
    throw new MpError("O Mercado Pago não gerou o QR Code do Pix. Verifique se a conta pode receber via Pix.", 502, "no_qr");
  }
  return { payment, qr_code: td.qr_code, qr_base64: td.qr_code_base64, ticket_url: td.ticket_url };
}

export const is_paid = (status) => status === "approved";

// Validação opcional da assinatura do webhook (só se MP_WEBHOOK_SECRET estiver definido).
// Manifesto: id:<data.id minúsculo>;request-id:<x-request-id>;ts:<ts>;  -> HMAC-SHA256 hex
export function webhook_signature_ok(req, data_id) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const sig = String(req.headers["x-signature"] || "");
  const ts = /(?:^|,)\s*ts=([^,]+)/.exec(sig)?.[1];
  const v1 = /(?:^|,)\s*v1=([^,]+)/.exec(sig)?.[1];
  if (!ts || !v1) return false;
  const manifest = `id:${String(data_id).toLowerCase()};request-id:${req.headers["x-request-id"] || ""};ts:${ts};`;
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Discord (usado como banco de dados pelo projeto) ----------

const discord_headers = { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" };

export async function discord_post(channel_id, content) {
  const r = await fetch(`${DISCORD_API}/channels/${channel_id}/messages`, {
    method: "POST", headers: discord_headers, body: JSON.stringify({ content }),
  });
  return r.json();
}

export async function discord_patch(channel_id, msg_id, content) {
  const r = await fetch(`${DISCORD_API}/channels/${channel_id}/messages/${msg_id}`, {
    method: "PATCH", headers: discord_headers, body: JSON.stringify({ content }),
  });
  return r.json();
}

export async function fetch_all_messages(channel_id) {
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

export async function find_user_by_email(email) {
  const messages = await fetch_all_messages(CHANNEL_USUARIOS);
  for (const msg of messages) {
    try {
      const data = JSON.parse(msg.content);
      if (data.email === String(email).toLowerCase()) return { ...data, msg_id: msg.id };
    } catch {}
  }
  return null;
}

export function simple_hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

async function activate_user_plan(email, plan_price) {
  const user = await find_user_by_email(email);
  if (!user) return;
  const { msg_id, ...clean } = user;
  await discord_patch(CHANNEL_USUARIOS, msg_id, JSON.stringify({ ...clean, plan: plan_price, plan_activated_at: new Date().toISOString() }));

  if (!user.referred_by) return;
  const referrer = await find_user_by_email(user.referred_by);
  const plan = PLANS.find((p) => p.price === plan_price);
  if (!referrer || !plan) return;

  const { msg_id: ref_msg_id, ...ref_clean } = referrer;
  await discord_patch(CHANNEL_USUARIOS, ref_msg_id, JSON.stringify({ ...ref_clean, balance: (referrer.balance || 0) + plan.commission }));

  await discord_post(CHANNEL_COMISSOES, JSON.stringify({
    affiliate: referrer.email,
    from_user: email,
    amount: plan.commission,
    plan: plan_price,
    created_at: new Date().toISOString(),
  }));
}

// Marca como pago e ativa o plano. Idempotente (webhook e polling podem chegar juntos).
// Sempre reconsulta o pagamento na API do Mercado Pago; nunca confia só no que chegou na requisição.
const in_flight = new Set();
export async function settle_payment(payment_id) {
  const pid = String(payment_id);
  if (in_flight.has(pid)) return "approved";
  in_flight.add(pid);
  try {
    const payment = await mp("GET", `/v1/payments/${encodeURIComponent(pid)}`);
    if (!is_paid(payment.status)) return payment.status;

    const messages = await fetch_all_messages(CHANNEL_PAGAMENTOS);
    for (const msg of messages) {
      let data;
      try { data = JSON.parse(msg.content); } catch { continue; }
      if (String(data.payment_id) !== pid) continue;
      if (data.status === "approved") return "approved";

      if (Number(payment.transaction_amount) !== Number(data.plan_price)) {
        console.error("[settle] valor divergente", pid, payment.transaction_amount, data.plan_price);
        return "value_mismatch";
      }
      await discord_patch(CHANNEL_PAGAMENTOS, msg.id, JSON.stringify({ ...data, status: "approved", paid_at: new Date().toISOString() }));
      await activate_user_plan(data.email, data.plan_price);
      return "approved";
    }
    return "not_found";
  } finally {
    in_flight.delete(pid);
  }
}
