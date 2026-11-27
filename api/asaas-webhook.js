import { settle_payment } from "../lib/asaas.js";

// OPCIONAL. O site já confirma o pagamento sozinho (polling a cada poucos segundos).
// Configure este webhook no Asaas só se quiser ativar o plano mesmo com o usuário
// tendo fechado a página antes de pagar:
//   Asaas > Integrações > Webhooks > URL: https://SEU-SITE/api/asaas-webhook
//   Eventos: PAYMENT_RECEIVED e PAYMENT_CONFIRMED
//   Token de autenticação: o mesmo valor de ASAAS_WEBHOOK_TOKEN (32-255 caracteres)

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (expected && req.headers["asaas-access-token"] !== expected) {
    return res.status(401).json({ error: "token inválido" });
  }

  const { event, payment } = req.body || {};
  if ((event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") && payment?.id) {
    try {
      // settle_payment reconfirma o status direto na API do Asaas antes de ativar qualquer coisa
      await settle_payment(payment.id);
    } catch (e) {
      // responde 500 para o Asaas tentar de novo mais tarde
      console.error("[webhook] falha ao processar", payment.id, e);
      return res.status(500).json({ error: "falha ao processar" });
    }
  }
  // sempre 200 para eventos que não nos interessam (evita pausar a fila do webhook)
  return res.status(200).json({ ok: true });
}
