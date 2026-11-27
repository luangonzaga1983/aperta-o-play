import { settle_payment, webhook_signature_ok } from "../lib/mercadopago.js";

// O site já confirma o pagamento sozinho (polling). Este webhook é o reforço para quando o
// usuário fecha a página antes de pagar. A URL é enviada automaticamente em cada Pix
// (notification_url), então NÃO é preciso configurar nada no painel do Mercado Pago.
// Opcional: MP_WEBHOOK_SECRET (Suas integrações > Webhooks) para validar a assinatura.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  const body = req.body || {};
  const type = body.type || req.query?.type || req.query?.topic;
  const data_id = body?.data?.id || req.query?.["data.id"] || req.query?.id;

  if (type !== "payment" || !data_id) return res.status(200).json({ ok: true }); // outros eventos: ignora

  if (!webhook_signature_ok(req, data_id)) return res.status(401).json({ error: "assinatura inválida" });

  try {
    // settle_payment reconsulta o status direto na API do Mercado Pago antes de ativar qualquer coisa
    await settle_payment(data_id);
  } catch (e) {
    console.error("[mp-webhook] falha ao processar", data_id, e);
    return res.status(500).json({ error: "falha ao processar" }); // o Mercado Pago tenta de novo
  }
  return res.status(200).json({ ok: true });
}
