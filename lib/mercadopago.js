// Cliente Mercado Pago + regras de pagamento compartilhadas entre /api/pay e /api/mp-webhook.
// Docs: https://www.mercadopago.com.br/developers
//
// Única variável obrigatória: MP_ACCESS_TOKEN (Vercel > Settings > Environment Variables).

import { randomUUID, randomBytes, createHmac, timingSafeEqual, scryptSync, createPrivateKey, sign as crypto_sign } from "node:crypto";
import { fit_content, log_event } from "./store.js";

export const ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim().replace(/^["']|["']$/g, "");
const MP_API = "https://api.mercadopago.com";

const DISCORD_API = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const CHANNEL_USUARIOS   = process.env.DISCORD_CHANNEL_USUARIOS;
export const CHANNEL_PAGAMENTOS = process.env.DISCORD_CHANNEL_PAGAMENTOS;
export const CHANNEL_COMISSOES  = process.env.DISCORD_CHANNEL_COMISSOES;
export const CHANNEL_SAQUES     = process.env.DISCORD_CHANNEL_SAQUES;
export const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();

// Comissão do afiliado: SEMPRE 50% do valor do plano.
export const COMMISSION_RATE = 0.5;
export const PLANS = [1, 25, 50, 100].map((price) => ({ price, commission: Math.round(price * COMMISSION_RATE * 100) / 100 }));

export class MpError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// ---------- Mercado Pago ----------

export async function mp(method, path, body, extra_headers = {}, sign_body = false) {
  if (!ACCESS_TOKEN) throw new MpError("Access Token do Mercado Pago não configurado (MP_ACCESS_TOKEN).", 500, "no_token");

  const raw = body ? JSON.stringify(body) : undefined;
  const signature_headers = sign_body && raw ? payout_signature_headers(raw) : {};

  let r;
  try {
    r = await fetch(`${MP_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        ...(method === "POST" ? { "X-Idempotency-Key": randomUUID() } : {}), // obrigatório nos POSTs
        ...extra_headers,
        ...signature_headers,
      },
      body: raw,
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

// ---------- saque automático (Mercado Pago Payouts / Money Out) ----------
// Requer: chave privada ed25519 em MP_PAYOUTS_PRIVATE_KEY (PEM) e a chave pública registrada no
// Mercado Pago (equipe de Integrações). Sem isso o saque cai no modo manual (admin confirma).

const PAYOUT_PEM = String(process.env.MP_PAYOUTS_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
export const PAYOUTS_ENABLED = !!PAYOUT_PEM;
export const MAX_AUTO_WITHDRAW = Number(process.env.MAX_AUTO_WITHDRAW || 500); // acima disso o admin revisa

function payout_signature_headers(raw_body) {
  if (!PAYOUT_PEM) return { "x-enforce-signature": "false" };
  const sig = crypto_sign(null, Buffer.from(raw_body), createPrivateKey(PAYOUT_PEM)).toString("base64");
  return { "x-signature": sig, "x-enforce-signature": "true" };
}

export async function mp_payout({ amount, key, type, owner_doc, ref }) {
  const value = Number(Number(amount).toFixed(2));
  const doc = only_digits(owner_doc);
  if (type === "PHONE") { const d = only_digits(key); key = `+${d.startsWith("55") && d.length > 11 ? d : "55" + d}`; } // chave Pix de telefone vai como +55DDDNÚMERO
  return mp("POST", "/v1/transaction-intents/process", {
    external_reference: ref,
    point_of_interaction: { type: "PSP_TRANSFER" },
    transaction: {
      from: { accounts: [{ amount: value }] },
      to: {
        accounts: [{
          type: "current",
          amount: value,
          chave: { type, value: key },
          owner: { identification: { type: doc.length === 14 ? "CNPJ" : "CPF", number: doc } },
        }],
      },
      total_amount: value,
    },
  }, { "X-Idempotency-Key": ref }, true); // mesma ref = mesma operação (não duplica em retry)
}

// ---------- sessão (token assinado) e senhas ----------

const SESSION_SECRET = process.env.SESSION_SECRET || BOT_TOKEN || "";
const b64u = (b) => Buffer.from(b).toString("base64url");

export function make_token(email, days = 30) {
  const payload = b64u(JSON.stringify({ e: String(email).toLowerCase(), x: Date.now() + days * 86400000, i: Date.now() }));
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// devolve o e-mail do dono do token, ou null se inválido/expirado
export function verify_token(token) {
  if (!SESSION_SECRET || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d.x > Date.now() ? d.e : null;
  } catch { return null; }
}

export function read_token(token) {
  const email = verify_token(token);
  if (!email) return null;
  const data = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  return { email, issued_at: data.i || 0, expires_at: data.x };
}

export function hash_password(pw) {
  const salt = randomBytes(16).toString("hex");
  return `s1$${salt}$${scryptSync(String(pw), salt, 32).toString("hex")}`;
}

// aceita o hash novo (scrypt) e o antigo (simple_hash) das contas já existentes
export function verify_password(pw, stored) {
  if (!stored) return false;
  if (stored.startsWith("s1$")) {
    const [, salt, hex] = stored.split("$");
    const a = scryptSync(String(pw), salt, 32), b = Buffer.from(hex, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return stored === simple_hash(String(pw));
}

// ---------- Google ----------

export const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();

// Valida o ID token do "Continuar com Google" direto no Google
export async function verify_google(credential) {
  if (!GOOGLE_CLIENT_ID || !credential) return null;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!r.ok) return null;
    const d = await r.json();
    const ok = d.aud === GOOGLE_CLIENT_ID
      && (d.email_verified === true || d.email_verified === "true")
      && (d.iss === "accounts.google.com" || d.iss === "https://accounts.google.com")
      && Number(d.exp) * 1000 > Date.now();
    return ok && d.email ? { email: String(d.email).toLowerCase(), name: d.name || "" } : null;
  } catch { return null; }
}

// ---------- validações ----------

// WhatsApp BR: DDD + número (10 ou 11 dígitos). Aceita +55 na frente.
export function norm_phone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return /^[1-9]\d9?\d{8}$/.test(d) && (d.length === 10 || d.length === 11) ? d : null;
}

export function valid_pix_key(type, key) {
  const k = String(key || "").trim();
  if (type === "CPF") return valid_cpf(k);
  if (type === "CNPJ") return valid_cnpj(k);
  if (type === "EMAIL") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k);
  if (type === "PHONE") return !!norm_phone(k);
  if (type === "EVP") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k);
  return false;
}

export const PIX_TYPES = { cpf: "CPF", cnpj: "CNPJ", email: "EMAIL", phone: "PHONE", telefone: "PHONE", random: "EVP", evp: "EVP", aleatoria: "EVP" };

export function normalize_pix_key(type, key) {
  const k = String(key || "").trim();
  if (type === "CPF" || type === "CNPJ") return only_digits(k);
  if (type === "PHONE") return norm_phone(k) || only_digits(k);
  if (type === "EMAIL") return k.toLowerCase();
  return k.toLowerCase();
}

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
      ...(valid_doc(doc) ? { identification: { type: doc.length === 14 ? "CNPJ" : "CPF", number: doc } } : {}),
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

export async function activate_user_plan(email, plan_price) {
  const user = await find_user_by_email(email);
  if (!user) return;
  const { msg_id, ...clean } = user;
  const now = new Date().toISOString();
  // Premium fica salvo no cadastro do usuário (canal de usuários do Discord, que não expira).
  // Pagar um plano menor depois nunca rebaixa o plano que ele já tem; premium_since guarda a 1ª ativação.
  const best_plan = Math.max(Number(user.plan) || 0, plan_price);
  await discord_patch(CHANNEL_USUARIOS, msg_id, fit_content({ ...clean, plan: best_plan, plan_activated_at: now, premium_since: user.premium_since || now }));
  await log_event("premium_activated", { email: user.email, plan: best_plan, paid_plan: plan_price });

  if (!user.referred_by) return;
  const referrer = await find_user_by_email(user.referred_by);
  const plan = PLANS.find((p) => p.price === plan_price);
  if (!referrer || !plan) return;

  const { msg_id: ref_msg_id, ...ref_clean } = referrer;
  await discord_patch(CHANNEL_USUARIOS, ref_msg_id, fit_content({ ...ref_clean, balance: Math.round(((referrer.balance || 0) + plan.commission) * 100) / 100 }));

  await discord_post(CHANNEL_COMISSOES, JSON.stringify({
    affiliate: referrer.email,
    from_user: email,
    amount: plan.commission,
    plan: plan_price,
    created_at: new Date().toISOString(),
  }));

  // Split automático: se o afiliado ativou "receber direto", a comissão já sai por Pix para a chave dele
  if (referrer.auto_payout && referrer.pix_key && PAYOUTS_ENABLED) {
    try {
      await process_withdrawal({
        email: referrer.email, amount: plan.commission, source: "auto_commission",
        key: referrer.pix_key, type: referrer.pix_type, owner_doc: referrer.owner_doc,
      });
    } catch (e) {
      console.error("[auto_payout] falhou; comissão fica no saldo", referrer.email, e.message); // o saldo já foi creditado
    }
  }
}

// ---------- saque (automático quando Payouts está ativo; senão fica pendente para o admin) ----------

export async function update_user(msg_id, data) {
  return discord_patch(CHANNEL_USUARIOS, msg_id, fit_content(data));
}

const withdrawing = new Set(); // trava simples por usuário (evita dois saques simultâneos na mesma instância)

export async function process_withdrawal({ email, amount, key, type, owner_doc, source = "user" }) {
  email = String(email).toLowerCase();
  amount = Number(Number(amount).toFixed(2));
  if (!(amount > 0)) throw new MpError("Valor inválido", 400, "invalid_amount");
  if (withdrawing.has(email)) throw new MpError("Já existe um saque em andamento. Aguarde alguns segundos.", 429, "busy");
  withdrawing.add(email);

  try {
    const user = await find_user_by_email(email);
    if (!user) throw new MpError("Usuário não encontrado", 404, "no_user");
    if ((user.balance || 0) < amount) throw new MpError("Saldo insuficiente", 400, "no_balance");

    // 1) desconta o saldo ANTES de enviar (nunca paga sem ter debitado)
    const { msg_id, ...user_data } = user;
    await update_user(msg_id, { ...user_data, balance: Number(((user.balance || 0) - amount).toFixed(2)) });
    const give_back = async () => {
      const fresh = await find_user_by_email(email);
      if (!fresh) return;
      const { msg_id: mid, ...d } = fresh;
      await update_user(mid, { ...d, balance: Number(((fresh.balance || 0) + amount).toFixed(2)) });
    };

    // 2) registra o saque; se não conseguir registrar, devolve o saldo e avisa (nunca some dinheiro sem registro)
    const ref = randomUUID().replace(/-/g, "").slice(0, 32);
    const record = { email, amount, pix_key: key, pix_type: type, owner_doc: only_digits(owner_doc), ref, source, status: "pending", created_at: new Date().toISOString() };
    let posted = null;
    try { posted = await discord_post(CHANNEL_SAQUES, JSON.stringify(record)); } catch (e) { console.error("[saque] registro falhou", e.message); }
    const saque_id = posted?.id;
    if (!saque_id) {
      await give_back().catch((e) => console.error("[saque] devolução falhou", email, amount, e.message));
      throw new MpError("Não foi possível registrar o saque agora. Seu saldo foi mantido; tente de novo em instantes.", 503, "record_failed");
    }
    const set_status = (extra) => discord_patch(CHANNEL_SAQUES, saque_id, JSON.stringify({ ...record, ...extra })).catch((e) => console.error("[saque] status falhou", e.message));

    // 3) sem Payouts, ou valor alto: fica pendente para o admin pagar
    if (!PAYOUTS_ENABLED || amount > MAX_AUTO_WITHDRAW) return { status: "pending" };

    // 4) envia o Pix
    try {
      const t = await mp_payout({ amount, key, type, owner_doc: type === "CPF" || type === "CNPJ" ? key : owner_doc, ref });
      const done = ["approved", "processed", "completed"].includes(String(t.status || "").toLowerCase());
      await set_status({ status: done ? "approved" : "processing", transfer_id: t.id ? String(t.id) : ref, mp_status: t.status || null });
      return { status: done ? "approved" : "processing" };
    } catch (e) {
      if (e instanceof MpError) {
        // problema da NOSSA conta (token, permissão, saldo, limite): não é culpa do usuário.
        // O saque fica pendente para o admin pagar depois, sem mostrar erro técnico para o usuário.
        if ([401, 403, 404, 429].includes(e.status) || /saldo|insufficient|funds|balance/i.test(`${e.message} ${e.code}`)) {
          console.error("[saque] Payouts indisponível; ficou pendente", e.status, e.message);
          await set_status({ status: "pending", fail_reason: `Pix automático indisponível: ${e.message}` });
          return { status: "pending" };
        }
        // recusa definitiva por dados do usuário (chave inexistente, CPF não bate...): devolve o saldo
        if (e.status >= 400 && e.status < 500) {
          await give_back();
          await set_status({ status: "rejected", fail_reason: e.message });
          throw new MpError(`O banco recusou o Pix: ${e.message}. Seu saldo foi devolvido. Confira a chave Pix e o CPF do titular.`, 400, e.code);
        }
      }
      // erro incerto (rede / 5xx): NÃO devolve nem paga de novo; o admin confere no painel
      await set_status({ status: "processing", fail_reason: "resposta incerta do Mercado Pago; conferir no painel" });
      return { status: "processing" };
    }
  } finally {
    withdrawing.delete(email);
  }
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
