// Cliente Asaas + regras de pagamento compartilhadas entre /api/assas e /api/asaas-webhook.
// Docs: https://docs.asaas.com
//
// Única coisa que você precisa configurar: ASAAS_API_KEY (Vercel > Settings > Environment Variables).
// O ambiente (sandbox/produção) é detectado sozinho pelo prefixo da chave:
//   $aact_prod_...  -> https://api.asaas.com/v3
//   $aact_hmlg_...  -> https://api-sandbox.asaas.com/v3

const clean_key = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");

// aceita o nome novo e os nomes antigos do projeto (ASSAS_TOKEN)
export const API_KEY = clean_key(process.env.ASAAS_API_KEY || process.env.ASAAS_TOKEN || process.env.ASSAS_TOKEN);
export const IS_SANDBOX = API_KEY.includes("_hmlg_") || process.env.ASAAS_ENV === "sandbox";
export const ASAAS_API = IS_SANDBOX ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";

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

export class AsaasError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// ---------- Asaas ----------

export async function asaas(method, path, body) {
  if (!API_KEY) throw new AsaasError("Chave da API do Asaas não configurada (ASAAS_API_KEY).", 500, "no_key");

  let r;
  try {
    r = await fetch(`${ASAAS_API}${path}`, {
      method,
      headers: {
        access_token: API_KEY,                       // o Asaas NÃO usa "Authorization: Bearer"
        "Content-Type": "application/json",
        "User-Agent": "apertaoplay/1.0 (vercel)",    // obrigatório em contas criadas a partir de 13/06/2024
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AsaasError("Não foi possível conectar ao Asaas. Tente novamente.", 502, "network");
  }

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* resposta sem JSON */ }

  if (!r.ok) {
    const first = data?.errors?.[0];
    const code = first?.code || `http_${r.status}`;
    let msg = first?.description || `Erro ${r.status} no Asaas`;
    if (r.status === 401) {
      msg = code === "invalid_environment"
        ? "A chave do Asaas é de outro ambiente (sandbox x produção)."
        : "Chave da API do Asaas inválida. Confira ASAAS_API_KEY (mantenha o $ do início, sem aspas ou espaços).";
    }
    console.error("[asaas]", method, path, r.status, JSON.stringify(data));
    throw new AsaasError(msg, r.status, code);
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

// ---------- clientes e cobranças ----------

// Reaproveita o cliente do mesmo e-mail (o Asaas permite duplicados, então evitamos criar um por cobrança)
export async function ensure_customer({ email, name, cpf_cnpj }) {
  const doc = only_digits(cpf_cnpj);
  const found = await asaas("GET", `/customers?externalReference=${encodeURIComponent(email)}&limit=1`);
  const existing = found?.data?.[0];

  if (existing) {
    const patch = {};
    if (doc && only_digits(existing.cpfCnpj) !== doc) patch.cpfCnpj = doc;
    if (name && !existing.name) patch.name = name;
    if (Object.keys(patch).length) await asaas("PUT", `/customers/${existing.id}`, patch);
    return existing.id;
  }

  const created = await asaas("POST", "/customers", {
    name: name || email.split("@")[0],
    email,
    cpfCnpj: doc,
    externalReference: email,
    notificationDisabled: true, // não manda e-mail/SMS do Asaas para o usuário
  });
  return created.id;
}

// data de hoje no fuso de Brasília (o Asaas valida dueDate no horário do Brasil)
export function today_br(offset_days = 0) {
  const d = new Date(Date.now() + offset_days * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); // YYYY-MM-DD
}

export async function create_pix_charge({ email, plan, name, cpf_cnpj }) {
  const customer = await ensure_customer({ email, name, cpf_cnpj });

  const charge = await asaas("POST", "/payments", {
    customer,
    billingType: "PIX",
    value: Number(plan.price.toFixed(2)),
    dueDate: today_br(1),
    description: `Aperta o Play - Plano R$${plan.price}`,
    externalReference: `${email}|${plan.price}`,
  });

  const qr = await asaas("GET", `/payments/${charge.id}/pixQrCode`);
  if (!qr?.payload) {
    throw new AsaasError(
      "O Asaas não gerou o QR Code. Verifique se há uma chave Pix cadastrada na sua conta Asaas.", 502, "no_qr");
  }
  return { charge, qr };
}

export const is_paid = (status) => status === "RECEIVED" || status === "CONFIRMED";

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

// Marca a cobrança como paga e ativa o plano. Idempotente: se já foi aprovada, não faz nada
// (webhook e "Já paguei" podem chegar juntos, ou o Asaas pode reenviar o mesmo evento).
const in_flight = new Set();
export async function settle_payment(assas_id) {
  if (in_flight.has(assas_id)) return "approved";
  in_flight.add(assas_id);
  try {
    // sempre confirma direto na API do Asaas; nunca confia só no que chegou na requisição
    const payment = await asaas("GET", `/payments/${assas_id}`);
    if (!is_paid(payment.status)) return payment.status;

    const messages = await fetch_all_messages(CHANNEL_PAGAMENTOS);
    for (const msg of messages) {
      let data;
      try { data = JSON.parse(msg.content); } catch { continue; }
      if (data.assas_id !== assas_id) continue;
      if (data.status === "approved") return "approved";

      // confere se o valor pago bate com o plano registrado
      if (Number(payment.value) !== Number(data.plan_price)) {
        console.error("[settle] valor divergente", assas_id, payment.value, data.plan_price);
        return "value_mismatch";
      }
      await discord_patch(CHANNEL_PAGAMENTOS, msg.id, JSON.stringify({ ...data, status: "approved", paid_at: new Date().toISOString() }));
      await activate_user_plan(data.email, data.plan_price);
      return "approved";
    }
    return "not_found";
  } finally {
    in_flight.delete(assas_id);
  }
}
