import {
  PLANS, ADMIN_EMAIL, CHANNEL_USUARIOS, CHANNEL_PAGAMENTOS,
  AsaasError, asaas, create_pix_charge, settle_payment, is_paid,
  discord_post, find_user_by_email, simple_hash, valid_doc, only_digits,
} from "../lib/asaas.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

// tipos de chave aceitos pelo Asaas: CPF, CNPJ, EMAIL, PHONE, EVP
const PIX_TYPES = { cpf: "CPF", cnpj: "CNPJ", email: "EMAIL", phone: "PHONE", telefone: "PHONE", random: "EVP", evp: "EVP", aleatoria: "EVP" };

function normalize_pix_key(type, key) {
  const k = String(key || "").trim();
  if (type === "CPF" || type === "CNPJ") return only_digits(k);
  if (type === "PHONE") return only_digits(k).replace(/^55(?=\d{11}$)/, "");
  if (type === "EMAIL") return k.toLowerCase();
  return k;
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
    const { charge, qr } = await create_pix_charge({ email, plan, name, cpf_cnpj });

    await discord_post(CHANNEL_PAGAMENTOS, JSON.stringify({
      email, plan_price: plan.price, assas_id: charge.id, status: "pending", created_at: new Date().toISOString(),
    }));

    return res.status(200).json({
      assas_id: charge.id,
      qr_code: qr.payload,
      qr_base64: qr.encodedImage,
      expires_at: qr.expirationDate || null,
      amount: plan.price,
    });
  }

  // ---------- consultar pagamento (o site faz polling; o webhook é opcional) ----------
  if (action === "check_payment") {
    const { assas_id } = body;
    const email = String(body.email || "").trim().toLowerCase();
    if (!assas_id || !email) return res.status(400).json({ error: "Dados inválidos" });

    const payment = await asaas("GET", `/payments/${encodeURIComponent(assas_id)}`);
    // a cobrança precisa pertencer a quem está perguntando
    if (!String(payment.externalReference || "").startsWith(`${email}|`)) {
      return res.status(403).json({ error: "Cobrança não pertence a este usuário" });
    }
    if (!is_paid(payment.status)) return res.status(200).json({ status: payment.status });

    const result = await settle_payment(assas_id);
    return res.status(200).json({ status: result === "approved" ? "approved" : result });
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

    // POST /v3/transfers com a chave Pix direto no corpo (sem "bankAccount")
    const transfer = await asaas("POST", "/transfers", {
      value: Number(value.toFixed(2)),
      pixAddressKey: key,
      pixAddressKeyType: type,
      description: "Saque Aperta o Play",
    });

    return res.status(200).json({ transfer_id: transfer.id, status: transfer.status });
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
    if (e instanceof AsaasError) return res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message, code: e.code });
    console.error("[assas] erro inesperado", e);
    return res.status(500).json({ error: "Erro interno. Tente novamente." });
  }
}
