import { randomUUID } from "node:crypto";
import {
  PLANS, ADMIN_EMAIL, CHANNEL_PAGAMENTOS,
  MpError, mp, create_pix_payment, settle_payment, is_paid,
  discord_post, find_user_by_email, simple_hash, valid_doc, only_digits,
} from "../lib/mercadopago.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

// tipos de chave Pix
const PIX_TYPES = { cpf: "CPF", cnpj: "CNPJ", email: "EMAIL", phone: "PHONE", telefone: "PHONE", random: "EVP", evp: "EVP", aleatoria: "EVP" };

function normalize_pix_key(type, key) {
  const k = String(key || "").trim();
  if (type === "CPF" || type === "CNPJ") return only_digits(k);
  if (type === "PHONE") return only_digits(k).replace(/^55(?=\d{11}$)/, "");
  if (type === "EMAIL") return k.toLowerCase();
  return k;
}

// URL pública do site (o Mercado Pago avisa aqui quando o Pix é pago, sem configurar nada no painel)
function site_url(req) {
  const env = process.env.SITE_URL;
  if (env) return env.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `https://${host}` : null;
}

async function handle(req, res) {
  const { action, ...body } = req.body || {};

  // ---------- gerar Pix ----------
  if (action === "create_pix") {
    const email = String(body.email || "").trim().toLowerCase();
    const plan = PLANS.find((p) => p.price === Number(body.plan_price));
    if (!email) return res.status(400).json({ error: "E-mail inválido" });
    if (!plan) return res.status(400).json({ error: "Plano inválido" });

    const cpf_cnpj = only_digits(body.cpf_cnpj);
    if (!valid_doc(cpf_cnpj)) return res.status(400).json({ error: "Informe um CPF válido para gerar o Pix.", code: "invalid_cpf" });

    const name = String(body.name || "").trim().slice(0, 100);
    const base = site_url(req);
    const { payment, qr_code, qr_base64, ticket_url } = await create_pix_payment({
      email, plan, name, cpf_cnpj,
      notification_url: base ? `${base}/api/mp-webhook` : null,
    });

    await discord_post(CHANNEL_PAGAMENTOS, JSON.stringify({
      email, plan_price: plan.price, payment_id: String(payment.id), status: "pending", created_at: new Date().toISOString(),
    }));

    return res.status(200).json({
      payment_id: String(payment.id),
      qr_code,
      qr_base64,
      ticket_url: ticket_url || null,
      amount: plan.price,
    });
  }

  // ---------- consultar pagamento (o site faz polling; o webhook é um reforço) ----------
  if (action === "check_payment") {
    const { payment_id } = body;
    const email = String(body.email || "").trim().toLowerCase();
    if (!payment_id || !email) return res.status(400).json({ error: "Dados inválidos" });

    const payment = await mp("GET", `/v1/payments/${encodeURIComponent(payment_id)}`);
    // a cobrança precisa pertencer a quem está perguntando
    if (!String(payment.external_reference || "").startsWith(`${email}|`)) {
      return res.status(403).json({ error: "Cobrança não pertence a este usuário" });
    }
    if (!is_paid(payment.status)) return res.status(200).json({ status: payment.status });

    const result = await settle_payment(payment_id);
    return res.status(200).json({ status: result });
  }

  // ---------- saque (admin) ----------
  if (action === "create_withdrawal_pix") {
    const { email, password, amount, pix_key, pix_type } = body;

    const admin = await find_user_by_email(email || "");
    if (!admin || String(email).toLowerCase() !== ADMIN_EMAIL || admin.password_hash !== simple_hash(String(password || ""))) {
      return res.status(403).json({ error: "Acesso negado" });
    }

    const type = PIX_TYPES[String(pix_type || "").toLowerCase()];
    const value = Number(amount);
    if (!type) return res.status(400).json({ error: "Tipo de chave Pix inválido" });
    if (!(value > 0)) return res.status(400).json({ error: "Valor inválido" });
    const key = normalize_pix_key(type, pix_key);
    if (!key) return res.status(400).json({ error: "Chave Pix inválida" });

    // Padrão: saque MANUAL. O Mercado Pago só libera envio de Pix por API (Payouts / Money Out)
    // para contas habilitadas, com chaves de criptografia. Sem isso, o admin paga pelo app.
    if (process.env.MP_PAYOUTS !== "api") {
      return res.status(200).json({ manual: true, amount: value, pix_key: key, pix_type: type });
    }

    // Modo API (experimental, só com Payouts habilitado pelo Mercado Pago)
    const ref = randomUUID().replace(/-/g, "").slice(0, 20);
    const t = await mp("POST", "/v1/transaction-intents/process", {
      external_reference: ref,
      point_of_interaction: { type: "PSP_TRANSFER" },
      transaction: {
        from: { accounts: [{ amount: Number(value.toFixed(2)) }] },
        to: { accounts: [{ type: "current", amount: Number(value.toFixed(2)), chave: { type, value: key } }] },
        total_amount: Number(value.toFixed(2)),
      },
    }, { "x-enforce-signature": process.env.MP_PAYOUTS_SIGNATURE === "true" ? "true" : "false" });

    return res.status(200).json({ transfer_id: t.id ? String(t.id) : ref, status: t.status });
  }

  return res.status(400).json({ error: "Ação desconhecida" });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  try {
    return await handle(req, res);
  } catch (e) {
    if (e instanceof MpError) return res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message, code: e.code });
    console.error("[pay] erro inesperado", e);
    return res.status(500).json({ error: "Erro interno. Tente novamente." });
  }
}
