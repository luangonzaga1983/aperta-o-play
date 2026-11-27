import { define, field, staff, reason_field, c_admin_error } from "./registry.js";
import {
  load_all, load_logs, sort_rows, paginate, paging_fields, range_fields, csv_file, money, to_ms, within, text_has,
  count_by, ranked, series_by_day, approved, brt_day,
} from "./data.js";
import { get_row, patch_row, post_row, find_user, save_user, log_event, invalidate } from "../store.js";
import { mp, MpError, PLANS, PAYOUTS_ENABLED, mp_payout, settle_payment, activate_user_plan, PIX_TYPES, valid_pix_key, normalize_pix_key, only_digits, valid_doc } from "../mercadopago.js";
import { account_state } from "../gate.js";

const group = "Financeiro";
const plan_options = PLANS.map((plan) => ({ value: String(plan.price), label: `R$ ${plan.price}` }));
const payment_statuses = ["pending", "approved", "refunded", "cancelled", "expired"];
const withdrawal_statuses = ["pending", "processing", "approved", "rejected"];
const status_options = (list) => [{ value: "", label: "Todos" }, ...list.map((value) => ({ value, label: value }))];
const open_withdrawal = (entry) => entry.status === "pending" || entry.status === "processing";

async function row_of(key, id) {
  const row = await get_row(key, id);
  if (!row) throw new c_admin_error("Registro não encontrado", 404);
  return row;
}

const payment_row = (payment) => ({
  ...payment,
  created_ms: to_ms(payment.created_at) || payment.msg_at,
  paid_ms: to_ms(payment.paid_at) || null,
  delay_seconds: payment.paid_at ? Math.round((to_ms(payment.paid_at) - (to_ms(payment.created_at) || payment.msg_at)) / 1000) : null,
  manual: String(payment.payment_id || "").startsWith("manual-") || payment.source === "admin",
});

const withdrawal_row = (withdrawal) => ({ ...withdrawal, created_ms: to_ms(withdrawal.created_at) || withdrawal.msg_at });
const commission_row = (commission) => ({ ...commission, created_ms: to_ms(commission.created_at) || commission.msg_at });

function filter_payments(payments, input) {
  const query = String(input.q || "").toLowerCase();
  return payments.map(payment_row).filter((payment) => {
    if (query && ![payment.email, payment.payment_id, payment.msg_id].some((value) => text_has(value, query))) return false;
    if (input.status && payment.status !== input.status) return false;
    if (input.plan_price && String(payment.plan_price) !== input.plan_price) return false;
    if (input.origin === "manual" && !payment.manual) return false;
    if (input.origin === "mercadopago" && payment.manual) return false;
    return within(payment.created_ms, input.from, input.to);
  });
}

const payment_filters = [
  field.text("q", "Busca (e-mail, ID do pagamento)"),
  field.select("status", "Status", status_options(payment_statuses)),
  field.select("plan_price", "Plano", [{ value: "", label: "Todos" }, ...plan_options]),
  field.select("origin", "Origem", [{ value: "", label: "Todas" }, { value: "mercadopago", label: "Mercado Pago" }, { value: "manual", label: "Manual (admin)" }]),
  ...range_fields,
];

const payment_sorters = { created: (r) => r.created_ms, paid: (r) => r.paid_ms, amount: (r) => r.plan_price, email: (r) => r.email, status: (r) => r.status };

define("payments.list", group, "Listar pagamentos", { roles: staff.money, read: true, fields: [...payment_filters, ...paging_fields] }, async (ctx, input) => {
  const { payments } = await load_all();
  return paginate(sort_rows(filter_payments(payments, input), payment_sorters, input, "created"), input);
});

define("payments.export_csv", group, "Exportar pagamentos (CSV)", { roles: staff.money, fields: payment_filters }, async (ctx, input) => {
  const { payments } = await load_all();
  return csv_file("pagamentos", filter_payments(payments, input), [["email", (r) => r.email], ["valor", (r) => r.plan_price], ["status", (r) => r.status], ["payment_id", (r) => r.payment_id], ["criado_em", (r) => r.created_at], ["pago_em", (r) => r.paid_at], ["segundos_ate_pagar", (r) => r.delay_seconds], ["manual", (r) => r.manual]]);
});

define("payments.get", group, "Detalhes do pagamento", { roles: staff.money, read: true, target: "payment", fields: [field.text("id", "ID da mensagem", { required: true }), field.checkbox("live", "Consultar também no Mercado Pago")] }, async (ctx, input) => {
  const payment = payment_row(await row_of("payments", input.id));
  const user = await find_user(payment.email);
  const live = input.live && !payment.manual ? await mp("GET", `/v1/payments/${encodeURIComponent(payment.payment_id)}`).catch((error) => ({ error: error.message })) : null;
  return { payment, user: user ? { email: user.email, plan: user.plan || null, balance: money(user.balance), state: account_state(user) } : null, live };
});

define("payments.check_mercadopago", group, "Consultar pagamento no Mercado Pago", { roles: staff.money, read: true, fields: [field.text("payment_id", "ID do pagamento", { required: true })] }, async (ctx, input) => {
  const live = await mp("GET", `/v1/payments/${encodeURIComponent(input.payment_id)}`);
  return { status: live.status, status_detail: live.status_detail, amount: live.transaction_amount, payer: live.payer?.email, reference: live.external_reference, approved_at: live.date_approved, created_at: live.date_created };
});

define("payments.sync", group, "Reprocessar pagamento (confirma no MP e ativa plano)", { roles: staff.money, target: "payment", fields: [field.text("payment_id", "ID do pagamento", { required: true })] }, async (ctx, input) => ({ result: await settle_payment(input.payment_id) }));

define("payments.sync_pending", group, "Reprocessar todos os Pix pendentes recentes", { roles: staff.money, fields: [field.number("hours", "Janela (horas)", { default: 48 })] }, async (ctx, input) => {
  const { payments } = await load_all();
  const limit = Date.now() - input.hours * 3600000;
  const pending = payments.map(payment_row).filter((payment) => payment.status === "pending" && !payment.manual && payment.created_ms >= limit).slice(0, 40);
  const results = {};
  for (const payment of pending) results[payment.payment_id] = await settle_payment(payment.payment_id).catch((error) => `erro: ${error.message}`);
  invalidate();
  return { checked: pending.length, results };
});

define("payments.approve_manual", group, "Aprovar pagamento manualmente", { roles: staff.money, sudo: true, danger: true, target: "payment", fields: [field.text("id", "ID da mensagem do pagamento", { required: true }), field.checkbox("pay_commission", "Pagar comissão ao indicador", { default: true }), reason_field] }, async (ctx, input) => {
  const payment = await row_of("payments", input.id);
  if (payment.status === "approved") throw new c_admin_error("Pagamento já aprovado");
  await patch_row("payments", payment.msg_id, { ...payment, status: "approved", paid_at: new Date().toISOString(), approved_by: ctx.actor.email, approval_reason: input.reason });
  if (input.pay_commission) await activate_user_plan(payment.email, payment.plan_price);
  else {
    const user = await find_user(payment.email, { fresh: true });
    if (user) await save_user({ ...user, plan: payment.plan_price, plan_activated_at: new Date().toISOString(), premium_since: user.premium_since || new Date().toISOString() });
  }
  invalidate();
  return { ok: true };
});

define("payments.mark_refunded", group, "Marcar pagamento como reembolsado", { roles: staff.money, sudo: true, danger: true, target: "payment", fields: [field.text("id", "ID da mensagem do pagamento", { required: true }), field.checkbox("revoke_plan", "Remover o plano do usuário", { default: true }), field.checkbox("revert_commission", "Estornar a comissão do indicador", { default: true }), reason_field] }, async (ctx, input) => {
  const payment = await row_of("payments", input.id);
  if (payment.status === "refunded") throw new c_admin_error("Pagamento já reembolsado");
  await patch_row("payments", payment.msg_id, { ...payment, status: "refunded", refunded_at: new Date().toISOString(), refund_reason: input.reason, refunded_by: ctx.actor.email });
  const user = await find_user(payment.email, { fresh: true });
  if (user && input.revoke_plan && user.plan === payment.plan_price) await save_user({ ...user, plan: null, plan_activated_at: null });
  let reverted = 0;
  if (input.revert_commission) {
    const { commissions } = await load_all();
    const target = commissions.find((entry) => entry.from_user === payment.email && entry.plan === payment.plan_price && !entry.reverted);
    if (target) reverted = await revert_commission(target, ctx.actor.email, input.reason);
  }
  return { ok: true, commission_reverted: reverted };
});

define("payments.cancel_pending", group, "Cancelar Pix pendente", { roles: staff.money, target: "payment", fields: [field.text("id", "ID da mensagem do pagamento", { required: true })] }, async (ctx, input) => {
  const payment = await row_of("payments", input.id);
  if (payment.status !== "pending") throw new c_admin_error("Só é possível cancelar pagamentos pendentes");
  await patch_row("payments", payment.msg_id, { ...payment, status: "cancelled", cancelled_by: ctx.actor.email });
  return { ok: true };
});

define("payments.expire_stale", group, "Expirar Pix pendentes antigos", { roles: staff.money, sudo: true, fields: [field.number("hours", "Mais antigos que (horas)", { default: 24 })] }, async (ctx, input) => {
  const { payments } = await load_all();
  const limit = Date.now() - input.hours * 3600000;
  const stale = payments.map(payment_row).filter((payment) => payment.status === "pending" && payment.created_ms < limit).slice(0, 100);
  for (const payment of stale) await patch_row("payments", payment.msg_id, { ...(await row_of("payments", payment.msg_id)), status: "expired" });
  return { expired: stale.length };
});

define("payments.summary", group, "Resumo de pagamentos", { roles: staff.money, read: true, fields: range_fields }, async (ctx, input) => {
  const { payments } = await load_all();
  const rows = payments.map(payment_row).filter((payment) => within(payment.created_ms, input.from, input.to));
  const paid = rows.filter(approved);
  const delays = paid.map((payment) => payment.delay_seconds).filter((value) => value !== null && value >= 0).sort((a, b) => a - b);
  return {
    total: rows.length,
    by_status: count_by(rows, (row) => row.status),
    revenue: money(paid.reduce((sum, row) => sum + row.plan_price, 0)),
    revenue_by_plan: Object.fromEntries(PLANS.map((plan) => [plan.price, money(paid.filter((row) => row.plan_price === plan.price).length * plan.price)])),
    sales_by_plan: count_by(paid, (row) => `R$ ${row.plan_price}`),
    conversion_rate: rows.length ? money((paid.length / rows.length) * 100) : 0,
    average_ticket: paid.length ? money(paid.reduce((sum, row) => sum + row.plan_price, 0) / paid.length) : 0,
    median_seconds_to_pay: delays.length ? delays[Math.floor(delays.length / 2)] : null,
    manual_count: paid.filter((row) => row.manual).length,
  };
});

define("payments.daily", group, "Receita por dia", { roles: staff.money, read: true, fields: [field.number("days", "Dias", { default: 30 })] }, async (ctx, input) => {
  const { payments } = await load_all();
  const days = Math.min(365, Math.max(1, input.days));
  return { series: series_by_day(payments.map(payment_row).filter((row) => approved(row) && row.paid_ms), (row) => row.paid_ms, (row) => row.plan_price, days) };
});

async function revert_commission(commission, actor, reason, debit = true) {
  const current = await row_of("commissions", commission.msg_id);
  if (current.reverted) return 0;
  await patch_row("commissions", current.msg_id, { ...current, reverted: true, reverted_at: new Date().toISOString(), reverted_by: actor, revert_reason: reason });
  if (!debit) return current.amount;
  const user = await find_user(current.affiliate, { fresh: true });
  if (user) await save_user({ ...user, balance: money((user.balance || 0) - current.amount) });
  return current.amount;
}

const commission_filters = [
  field.text("q", "Busca (afiliado ou origem)"),
  field.select("state", "Situação", [{ value: "", label: "Todas" }, { value: "valid", label: "Válidas" }, { value: "reverted", label: "Estornadas" }]),
  ...range_fields,
];

const filter_commissions = (commissions, input) => {
  const query = String(input.q || "").toLowerCase();
  return commissions.map(commission_row).filter((commission) => {
    if (query && ![commission.affiliate, commission.from_user].some((value) => text_has(value, query))) return false;
    if (input.state === "valid" && commission.reverted) return false;
    if (input.state === "reverted" && !commission.reverted) return false;
    return within(commission.created_ms, input.from, input.to);
  });
};

define("commissions.list", group, "Listar comissões", { roles: staff.money, read: true, fields: [...commission_filters, ...paging_fields] }, async (ctx, input) => {
  const { commissions } = await load_all();
  return paginate(sort_rows(filter_commissions(commissions, input), { created: (r) => r.created_ms, amount: (r) => r.amount, affiliate: (r) => r.affiliate }, input, "created"), input);
});

define("commissions.export_csv", group, "Exportar comissões (CSV)", { roles: staff.money, fields: commission_filters }, async (ctx, input) => {
  const { commissions } = await load_all();
  return csv_file("comissoes", filter_commissions(commissions, input), [["afiliado", (r) => r.affiliate], ["origem", (r) => r.from_user], ["valor", (r) => r.amount], ["plano", (r) => r.plan], ["criada_em", (r) => r.created_at], ["estornada", (r) => !!r.reverted]]);
});

define("commissions.summary", group, "Resumo de comissões", { roles: staff.money, read: true, fields: range_fields }, async (ctx, input) => {
  const { commissions } = await load_all();
  const rows = filter_commissions(commissions, input);
  const valid = rows.filter((row) => !row.reverted);
  const per_affiliate = valid.reduce((acc, row) => ({ ...acc, [row.affiliate]: money((acc[row.affiliate] || 0) + row.amount) }), {});
  return {
    count: rows.length,
    total: money(valid.reduce((sum, row) => sum + row.amount, 0)),
    reverted_total: money(rows.filter((row) => row.reverted).reduce((sum, row) => sum + row.amount, 0)),
    affiliates: Object.keys(per_affiliate).length,
    top: Object.entries(per_affiliate).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 20),
  };
});

define("commissions.revert", group, "Estornar comissão", { roles: staff.money, sudo: true, danger: true, target: "commission", fields: [field.text("id", "ID da mensagem da comissão", { required: true }), field.checkbox("debit", "Debitar do saldo do afiliado", { default: true }), reason_field] }, async (ctx, input) => {
  const commission = await row_of("commissions", input.id);
  const amount = await revert_commission(commission, ctx.actor.email, input.reason, input.debit);
  if (!amount) throw new c_admin_error("Comissão já estornada");
  return { reverted: amount };
});

define("commissions.create_manual", group, "Lançar comissão manual", { roles: staff.money, sudo: true, danger: true, fields: [field.email("affiliate", "Afiliado", { required: true }), field.email("from_user", "Indicado de origem", { required: true }), field.number("amount", "Valor (R$)", { required: true }), field.select("plan", "Plano de referência", plan_options, { required: true }), reason_field] }, async (ctx, input) => {
  if (!(input.amount > 0)) throw new c_admin_error("Valor inválido");
  const affiliate = await find_user(input.affiliate, { fresh: true });
  if (!affiliate) throw new c_admin_error("Afiliado não encontrado", 404);
  await post_row("commissions", { affiliate: affiliate.email, from_user: input.from_user, amount: input.amount, plan: Number(input.plan), created_at: new Date().toISOString(), manual: true, created_by: ctx.actor.email, reason: input.reason });
  await save_user({ ...affiliate, balance: money((affiliate.balance || 0) + input.amount) });
  return { ok: true };
});

const withdrawal_filters = [
  field.text("q", "Busca (e-mail, chave Pix, ID)"),
  field.select("status", "Status", status_options(withdrawal_statuses)),
  field.select("source", "Origem", [{ value: "", label: "Todas" }, { value: "user", label: "Pedido do usuário" }, { value: "auto_commission", label: "Comissão automática" }]),
  field.number("min", "Valor mínimo"),
  field.number("max", "Valor máximo"),
  ...range_fields,
];

const filter_withdrawals = (withdrawals, input) => {
  const query = String(input.q || "").toLowerCase();
  return withdrawals.map(withdrawal_row).filter((withdrawal) => {
    if (query && ![withdrawal.email, withdrawal.pix_key, withdrawal.transfer_id, withdrawal.ref, withdrawal.msg_id].some((value) => text_has(value, query))) return false;
    if (input.status && withdrawal.status !== input.status) return false;
    if (input.source && (withdrawal.source || "user") !== input.source) return false;
    if (input.min !== undefined && withdrawal.amount < input.min) return false;
    if (input.max !== undefined && withdrawal.amount > input.max) return false;
    return within(withdrawal.created_ms, input.from, input.to);
  });
};

define("withdrawals.list", group, "Listar saques", { roles: staff.money, read: true, fields: [...withdrawal_filters, ...paging_fields] }, async (ctx, input) => {
  const { withdrawals } = await load_all();
  return paginate(sort_rows(filter_withdrawals(withdrawals, input), { created: (r) => r.created_ms, amount: (r) => r.amount, email: (r) => r.email, status: (r) => r.status }, input, "created"), input);
});

define("withdrawals.queue", group, "Fila de saques (pendentes e em processamento)", { roles: staff.money, read: true }, async () => {
  const { withdrawals, users } = await load_all();
  const rows = withdrawals.filter(open_withdrawal).map(withdrawal_row).sort((a, b) => a.created_ms - b.created_ms);
  return {
    rows: rows.map((row) => {
      const user = users.find((entry) => entry.email === row.email);
      return { ...row, user_plan: user?.plan || null, user_state: user ? account_state(user) : "missing", user_balance: money(user?.balance), account_age_days: user ? Math.floor((Date.now() - (to_ms(user.created_at) || user.msg_at)) / 86400000) : null, waiting_hours: Math.round((Date.now() - row.created_ms) / 360000) / 10 };
    }),
    total: money(rows.reduce((sum, row) => sum + row.amount, 0)),
    payouts_enabled: PAYOUTS_ENABLED,
  };
});

define("withdrawals.export_csv", group, "Exportar saques (CSV)", { roles: staff.money, fields: withdrawal_filters }, async (ctx, input) => {
  const { withdrawals } = await load_all();
  return csv_file("saques", filter_withdrawals(withdrawals, input), [["email", (r) => r.email], ["valor", (r) => r.amount], ["status", (r) => r.status], ["tipo_chave", (r) => r.pix_type], ["chave", (r) => r.pix_key], ["origem", (r) => r.source], ["transfer_id", (r) => r.transfer_id], ["criado_em", (r) => r.created_at], ["motivo", (r) => r.fail_reason || r.reject_reason]]);
});

define("withdrawals.summary", group, "Resumo de saques", { roles: staff.money, read: true, fields: range_fields }, async (ctx, input) => {
  const { withdrawals } = await load_all();
  const rows = filter_withdrawals(withdrawals, input);
  const total_of = (status) => money(rows.filter((row) => row.status === status).reduce((sum, row) => sum + row.amount, 0));
  return { count: rows.length, by_status: count_by(rows, (row) => row.status), paid: total_of("approved"), pending: total_of("pending"), processing: total_of("processing"), rejected: total_of("rejected"), top_withdrawers: ranked(rows.filter((row) => row.status !== "rejected").reduce((acc, row) => ({ ...acc, [row.email]: money((acc[row.email] || 0) + row.amount) }), {}), 15) };
});

define("withdrawals.mark_paid", group, "Marcar saque como pago", { roles: staff.money, sudo: true, target: "withdrawal", fields: [field.text("id", "ID da mensagem do saque", { required: true }), field.text("transfer_id", "ID/Comprovante do Pix (opcional)")] }, async (ctx, input) => {
  const withdrawal = await row_of("withdrawals", input.id);
  if (!open_withdrawal(withdrawal)) throw new c_admin_error("Esse saque não está em aberto");
  await patch_row("withdrawals", withdrawal.msg_id, { ...withdrawal, status: "approved", paid_at: new Date().toISOString(), paid_by: ctx.actor.email, ...(input.transfer_id ? { transfer_id: input.transfer_id } : {}) });
  return { ok: true };
});

async function reject_withdrawal(withdrawal, actor, reason, refund) {
  if (!open_withdrawal(withdrawal)) throw new c_admin_error("Esse saque não está em aberto");
  await patch_row("withdrawals", withdrawal.msg_id, { ...withdrawal, status: "rejected", reject_reason: reason, rejected_by: actor, refunded: refund || undefined });
  if (!refund) return;
  const user = await find_user(withdrawal.email, { fresh: true });
  if (user) await save_user({ ...user, balance: money((user.balance || 0) + withdrawal.amount) });
}

define("withdrawals.reject", group, "Rejeitar saque (e devolver saldo)", { roles: staff.money, sudo: true, danger: true, target: "withdrawal", fields: [field.text("id", "ID da mensagem do saque", { required: true }), field.checkbox("refund", "Devolver o valor ao saldo", { default: true }), reason_field] }, async (ctx, input) => {
  await reject_withdrawal(await row_of("withdrawals", input.id), ctx.actor.email, input.reason, input.refund);
  return { ok: true };
});

define("withdrawals.pay_api", group, "Pagar saque via API Pix (Payouts)", { roles: staff.money, sudo: true, danger: true, target: "withdrawal", fields: [field.text("id", "ID da mensagem do saque", { required: true })] }, async (ctx, input) => {
  if (!PAYOUTS_ENABLED) throw new c_admin_error("Payouts não está ativo (veja README_SAQUE.md)");
  const withdrawal = await row_of("withdrawals", input.id);
  if (!open_withdrawal(withdrawal)) throw new c_admin_error("Esse saque não está em aberto");
  try {
    const owner_doc = withdrawal.pix_type === "CPF" || withdrawal.pix_type === "CNPJ" ? withdrawal.pix_key : withdrawal.owner_doc;
    const transfer = await mp_payout({ amount: withdrawal.amount, key: withdrawal.pix_key, type: withdrawal.pix_type, owner_doc, ref: withdrawal.ref || withdrawal.msg_id.slice(0, 32) });
    const done = ["approved", "processed", "completed"].includes(String(transfer.status || "").toLowerCase());
    await patch_row("withdrawals", withdrawal.msg_id, { ...withdrawal, status: done ? "approved" : "processing", transfer_id: transfer.id ? String(transfer.id) : withdrawal.ref, paid_by: ctx.actor.email });
    return { status: done ? "approved" : "processing" };
  } catch (error) {
    if (error instanceof MpError) throw new c_admin_error(`Mercado Pago recusou: ${error.message}`, 400);
    throw error;
  }
});

define("withdrawals.set_pix", group, "Corrigir chave Pix de um saque em aberto", { roles: staff.money, sudo: true, target: "withdrawal", fields: [field.text("id", "ID da mensagem do saque", { required: true }), field.select("pix_type", "Tipo", ["cpf", "cnpj", "email", "phone", "random"].map((value) => ({ value, label: value.toUpperCase() })), { required: true }), field.text("pix_key", "Chave", { required: true }), field.text("owner_doc", "CPF/CNPJ do titular")] }, async (ctx, input) => {
  const withdrawal = await row_of("withdrawals", input.id);
  if (!open_withdrawal(withdrawal)) throw new c_admin_error("Esse saque não está em aberto");
  const type = PIX_TYPES[input.pix_type];
  if (!valid_pix_key(type, input.pix_key)) throw new c_admin_error("Chave Pix inválida");
  const key = normalize_pix_key(type, input.pix_key);
  const owner_doc = type === "CPF" || type === "CNPJ" ? key : only_digits(input.owner_doc);
  if (!valid_doc(owner_doc)) throw new c_admin_error("Informe o CPF/CNPJ do titular");
  await patch_row("withdrawals", withdrawal.msg_id, { ...withdrawal, pix_key: key, pix_type: type, owner_doc, key_fixed_by: ctx.actor.email });
  return { ok: true };
});

define("withdrawals.set_status", group, "Alterar status do saque (manual)", { roles: staff.money, sudo: true, danger: true, target: "withdrawal", fields: [field.text("id", "ID da mensagem do saque", { required: true }), field.select("status", "Novo status", withdrawal_statuses.map((value) => ({ value, label: value })), { required: true }), reason_field] }, async (ctx, input) => {
  const withdrawal = await row_of("withdrawals", input.id);
  await patch_row("withdrawals", withdrawal.msg_id, { ...withdrawal, status: input.status, status_note: input.reason, status_by: ctx.actor.email });
  return { ok: true };
});

define("withdrawals.bulk", group, "Pagar/rejeitar saques em lote", { roles: staff.money, sudo: true, danger: true, fields: [field.list("ids", "IDs dos saques", { required: true }), field.select("op", "Ação", [{ value: "mark_paid", label: "Marcar como pagos" }, { value: "reject", label: "Rejeitar e devolver saldo" }], { required: true }), field.text("reason", "Motivo (para rejeição)")] }, async (ctx, input) => {
  const done = [];
  const failed = [];
  for (const id of input.ids.slice(0, 50)) {
    try {
      const withdrawal = await row_of("withdrawals", id);
      if (input.op === "reject") await reject_withdrawal(withdrawal, ctx.actor.email, input.reason || "lote", true);
      else {
        if (!open_withdrawal(withdrawal)) throw new c_admin_error("não está em aberto");
        await patch_row("withdrawals", withdrawal.msg_id, { ...withdrawal, status: "approved", paid_at: new Date().toISOString(), paid_by: ctx.actor.email });
      }
      done.push(id);
    } catch (error) {
      failed.push({ id, error: error.message });
    }
  }
  return { done: done.length, failed };
});

const expected_balances = (all, logs) => {
  const expected = {};
  const add = (email, value) => { expected[email] = money((expected[email] || 0) + value); };
  for (const commission of all.commissions) if (!commission.reverted) add(commission.affiliate, commission.amount);
  for (const withdrawal of all.withdrawals) if (withdrawal.status !== "rejected") add(withdrawal.email, -withdrawal.amount);
  for (const log of logs) if (log.type === "ledger" && log.email) add(log.email, log.delta || 0);
  return expected;
};

define("finance.reconcile", group, "Conferir saldos (esperado × atual)", { roles: staff.money, read: true, fields: [field.checkbox("only_diff", "Só divergências", { default: true }), field.number("tolerance", "Tolerância (R$)", { default: 0.01 }), ...paging_fields.slice(0, 2)], description: "Recalcula o saldo de cada usuário: comissões válidas − saques não rejeitados ± ajustes manuais." }, async (ctx, input) => {
  const [all, logs] = await Promise.all([load_all(), load_logs(["ledger"])]);
  const expected = expected_balances(all, logs);
  const rows = all.users.map((user) => ({ email: user.email, actual: money(user.balance), expected: money(expected[user.email] || 0), diff: money(money(user.balance) - (expected[user.email] || 0)) })).filter((row) => !input.only_diff || Math.abs(row.diff) > input.tolerance).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return { ...paginate(rows, input), total_diff: money(rows.reduce((sum, row) => sum + row.diff, 0)), notice: "Ajustes manuais anteriores ao registro de auditoria não entram na conta." };
});

define("finance.fix_balance", group, "Corrigir saldo para o valor esperado", { roles: staff.money, sudo: true, danger: true, target: "user", fields: [field.email("email", "E-mail do usuário", { required: true }), reason_field] }, async (ctx, input) => {
  const [all, logs] = await Promise.all([load_all(), load_logs(["ledger"])]);
  const user = await find_user(input.email, { fresh: true });
  if (!user) throw new c_admin_error("Usuário não encontrado", 404);
  const target = money(expected_balances(all, logs)[user.email] || 0);
  const before = money(user.balance);
  await save_user({ ...user, balance: target });
  await log_event("ledger", { email: user.email, delta: money(target - before), before, after: target, reason: `conferência: ${input.reason}`, actor: ctx.actor.email });
  return { before, after: target };
});

define("finance.summary", group, "Resumo financeiro geral", { roles: staff.money, read: true }, async () => {
  const { users, payments, withdrawals, commissions } = await load_all();
  const now = Date.now();
  const paid = payments.map(payment_row).filter((row) => approved(row) && !row.manual);
  const revenue_since = (days) => money(paid.filter((row) => (row.paid_ms || row.created_ms) >= now - days * 86400000).reduce((sum, row) => sum + row.plan_price, 0));
  const valid = commissions.filter((entry) => !entry.reverted);
  const total_of = (status) => money(withdrawals.filter((row) => row.status === status).reduce((sum, row) => sum + row.amount, 0));
  const revenue_all = money(paid.reduce((sum, row) => sum + row.plan_price, 0));
  const commission_total = money(valid.reduce((sum, row) => sum + row.amount, 0));
  return {
    revenue: { today: revenue_since(1), week: revenue_since(7), month: revenue_since(30), all: revenue_all },
    commissions: { total: commission_total, count: valid.length, reverted: commissions.length - valid.length },
    margin: { gross: money(revenue_all - commission_total), percent: revenue_all ? money(((revenue_all - commission_total) / revenue_all) * 100) : 0 },
    withdrawals: { paid: total_of("approved"), pending: total_of("pending"), processing: total_of("processing"), rejected: total_of("rejected") },
    liabilities: { balances: money(users.reduce((sum, user) => sum + (user.balance || 0), 0)), users_with_balance: users.filter((user) => (user.balance || 0) > 0).length },
    cash_estimate: money(revenue_all - total_of("approved") - total_of("processing")),
  };
});

define("finance.series", group, "Série diária (receita, comissões, saques, cadastros)", { roles: staff.money, read: true, fields: [field.select("metric", "Métrica", [{ value: "revenue", label: "Receita" }, { value: "commissions", label: "Comissões" }, { value: "withdrawals", label: "Saques" }, { value: "signups", label: "Cadastros" }], { default: "revenue" }), field.number("days", "Dias", { default: 30 })] }, async (ctx, input) => {
  const all = await load_all();
  const days = Math.min(365, Math.max(1, input.days));
  const sources = {
    revenue: () => series_by_day(all.payments.map(payment_row).filter((row) => approved(row) && row.paid_ms), (row) => row.paid_ms, (row) => row.plan_price, days),
    commissions: () => series_by_day(all.commissions.filter((row) => !row.reverted).map(commission_row), (row) => row.created_ms, (row) => row.amount, days),
    withdrawals: () => series_by_day(all.withdrawals.filter((row) => row.status !== "rejected").map(withdrawal_row), (row) => row.created_ms, (row) => row.amount, days),
    signups: () => series_by_day(all.users, (row) => to_ms(row.created_at) || row.msg_at, () => 1, days),
  };
  return { series: sources[input.metric]() };
});

define("finance.liabilities", group, "Passivo: saldos em aberto dos afiliados", { roles: staff.money, read: true }, async () => {
  const { users } = await load_all();
  const holders = users.filter((user) => (user.balance || 0) > 0).sort((a, b) => b.balance - a.balance);
  const buckets = [[0, 10], [10, 50], [50, 100], [100, 500], [500, Infinity]].map(([low, high]) => ({ label: high === Infinity ? `R$ ${low}+` : `R$ ${low}–${high}`, value: holders.filter((user) => user.balance > low && user.balance <= high).length }));
  return { total: money(holders.reduce((sum, user) => sum + user.balance, 0)), holders: holders.length, buckets, top: holders.slice(0, 25).map((user) => ({ email: user.email, balance: money(user.balance), plan: user.plan || null, has_pix: !!user.pix_key })) };
});

define("finance.top_earners", group, "Maiores afiliados (comissões)", { roles: staff.money, read: true, fields: [field.number("limit", "Quantidade", { default: 20 })] }, async (ctx, input) => {
  const { commissions, users } = await load_all();
  const totals = commissions.filter((entry) => !entry.reverted).reduce((acc, entry) => ({ ...acc, [entry.affiliate]: { total: money((acc[entry.affiliate]?.total || 0) + entry.amount), sales: (acc[entry.affiliate]?.sales || 0) + 1 } }), {});
  const rows = Object.entries(totals).map(([email, value]) => ({ email, ...value, balance: money(users.find((user) => user.email === email)?.balance) })).sort((a, b) => b.total - a.total);
  return { rows: rows.slice(0, Math.min(100, input.limit)) };
});

define("finance.plan_mix", group, "Distribuição de planos", { roles: staff.money, read: true }, async () => {
  const { users } = await load_all();
  return { mix: ranked(count_by(users, (user) => user.plan ? `R$ ${user.plan}` : "Sem plano")), by_month: ranked(count_by(users.filter((user) => user.plan_activated_at), (user) => brt_day(to_ms(user.plan_activated_at)).slice(0, 7)), 24) };
});
