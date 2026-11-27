import { define, field, staff } from "./registry.js";
import {
  load_all, load_logs, money, to_ms, created_ms, count_by, ranked, series_by_day, approved, within,
  brt_day, brt_month, brt_hour, brt_weekday, range_fields,
} from "./data.js";
import { account_state } from "../gate.js";
import { channels } from "../store.js";

const group = "Analytics";
const day_ms = 86400000;
const days_field = field.number("days", "Dias", { default: 30 });
const clamp_days = (days) => Math.min(365, Math.max(1, days));
const percent = (part, whole) => whole ? money((part / whole) * 100) : 0;

const source_of = (user) => user.reg?.ut || user.reg?.rf || (user.referred_by ? "indicação" : "direto");

define("analytics.overview", group, "Painel geral (visão do dono)", { roles: staff.everyone, read: true }, async () => {
  const { users, payments, withdrawals, commissions } = await load_all();
  const now = Date.now();
  const signup_since = (days) => users.filter((user) => created_ms(user) >= now - days * day_ms).length;
  const paid = payments.filter((payment) => approved(payment) && !String(payment.payment_id).startsWith("manual-") && payment.source !== "admin");
  const paid_ms = (payment) => to_ms(payment.paid_at) || to_ms(payment.created_at) || payment.msg_at;
  const revenue_since = (days) => money(paid.filter((payment) => paid_ms(payment) >= now - days * day_ms).reduce((sum, payment) => sum + payment.plan_price, 0));
  const open = withdrawals.filter((withdrawal) => withdrawal.status === "pending" || withdrawal.status === "processing");
  const paying = users.filter((user) => user.plan).length;
  return {
    users: { total: users.length, today: signup_since(1), week: signup_since(7), month: signup_since(30), paying, conversion: percent(paying, users.length), banned: users.filter((user) => account_state(user) === "banned").length, active_24h: users.filter((user) => to_ms(user.last?.at) >= now - day_ms).length, active_7d: users.filter((user) => to_ms(user.last?.at) >= now - 7 * day_ms).length },
    revenue: { today: revenue_since(1), week: revenue_since(7), month: revenue_since(30), all: money(paid.reduce((sum, payment) => sum + payment.plan_price, 0)) },
    commissions: { total: money(commissions.filter((entry) => !entry.reverted).reduce((sum, entry) => sum + entry.amount, 0)) },
    withdrawals: { open: open.length, open_amount: money(open.reduce((sum, withdrawal) => sum + withdrawal.amount, 0)), oldest_hours: open.length ? Math.round((now - Math.min(...open.map((withdrawal) => to_ms(withdrawal.created_at) || withdrawal.msg_at))) / 360000) / 10 : 0 },
    liabilities: money(users.reduce((sum, user) => sum + (user.balance || 0), 0)),
    pending_payments: payments.filter((payment) => payment.status === "pending" && now - (to_ms(payment.created_at) || payment.msg_at) < day_ms).length,
    signups_series: series_by_day(users, created_ms, () => 1, 14),
    revenue_series: series_by_day(paid, paid_ms, (payment) => payment.plan_price, 14),
    top_countries: ranked(count_by(users, (user) => user.reg?.cc), 6),
    logging: { logs: !!channels.logs, config: !!channels.config },
  };
});

define("analytics.signups_series", group, "Cadastros por dia", { roles: staff.everyone, read: true, fields: [days_field] }, async (ctx, input) => {
  const { users } = await load_all();
  return { series: series_by_day(users, created_ms, () => 1, clamp_days(input.days)) };
});

define("analytics.monthly", group, "Cadastros e receita por mês", { roles: staff.money, read: true }, async () => {
  const { users, payments } = await load_all();
  const signups = count_by(users, (user) => brt_month(created_ms(user)));
  const revenue = payments.filter(approved).reduce((acc, payment) => {
    const key = brt_month(to_ms(payment.paid_at) || to_ms(payment.created_at) || payment.msg_at);
    return { ...acc, [key]: money((acc[key] || 0) + payment.plan_price) };
  }, {});
  const months = [...new Set([...Object.keys(signups), ...Object.keys(revenue)])].sort();
  return { rows: months.map((month) => ({ month, signups: signups[month] || 0, revenue: revenue[month] || 0 })) };
});

define("analytics.heatmap", group, "Mapa de calor (dia da semana × hora)", { roles: staff.everyone, read: true, fields: [field.select("kind", "Evento", [{ value: "signups", label: "Cadastros" }, { value: "logins", label: "Acessos" }, { value: "payments", label: "Pagamentos" }], { default: "signups" }), days_field] }, async (ctx, input) => {
  const limit = Date.now() - clamp_days(input.days) * day_ms;
  const times = input.kind === "payments"
    ? (await load_all()).payments.filter(approved).map((payment) => to_ms(payment.paid_at) || to_ms(payment.created_at))
    : input.kind === "logins"
      ? (await load_logs(["login"])).map((log) => log.ts)
      : (await load_all()).users.map(created_ms);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const time of times.filter((value) => value >= limit)) grid[brt_weekday(time)][brt_hour(time)]++;
  return { grid, labels: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] };
});

define("analytics.geo", group, "Geografia (país, estado, cidade)", { roles: staff.everyone, read: true, fields: [field.select("by", "Agrupar por", [{ value: "cc", label: "País" }, { value: "rg", label: "Estado/Região" }, { value: "ct", label: "Cidade" }], { default: "cc" }), field.select("kind", "Base", [{ value: "signups", label: "Cadastro" }, { value: "last", label: "Último acesso" }], { default: "signups" })] }, async (ctx, input) => {
  const { users } = await load_all();
  const pick = (user) => (input.kind === "last" ? user.last : user.reg)?.[input.by];
  return { rows: ranked(count_by(users, pick), 50), unknown: users.filter((user) => !pick(user)).length };
});

define("analytics.devices", group, "Dispositivos, sistemas e navegadores", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  return {
    devices: ranked(count_by(users, (user) => user.reg?.dv)),
    systems: ranked(count_by(users, (user) => user.reg?.os)),
    browsers: ranked(count_by(users, (user) => user.reg?.br)),
    languages: ranked(count_by(users, (user) => user.reg?.ln)),
    timezones: ranked(count_by(users, (user) => user.reg?.tz)),
    screens: ranked(count_by(users, (user) => user.reg?.sc)),
  };
});

define("analytics.sources", group, "Origem dos cadastros e conversão", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  const groups = {};
  for (const user of users) {
    const key = source_of(user);
    groups[key] = groups[key] || { label: key, signups: 0, paying: 0 };
    groups[key].signups++;
    if (user.plan) groups[key].paying++;
  }
  return { rows: Object.values(groups).map((entry) => ({ ...entry, conversion: percent(entry.paying, entry.signups) })).sort((a, b) => b.signups - a.signups).slice(0, 50) };
});

define("analytics.conversion_by_country", group, "Conversão por país", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  const groups = {};
  for (const user of users) {
    const key = user.reg?.cc || "desconhecido";
    groups[key] = groups[key] || { label: key, signups: 0, paying: 0 };
    groups[key].signups++;
    if (user.plan) groups[key].paying++;
  }
  return { rows: Object.values(groups).map((entry) => ({ ...entry, conversion: percent(entry.paying, entry.signups) })).sort((a, b) => b.signups - a.signups) };
});

define("analytics.funnel", group, "Funil de conversão", { roles: staff.everyone, read: true, fields: range_fields }, async (ctx, input) => {
  const { users, withdrawals } = await load_all();
  const scope = users.filter((user) => within(created_ms(user), input.from, input.to));
  const referrers = new Set(users.filter((user) => user.referred_by).map((user) => user.referred_by));
  const withdrew = new Set(withdrawals.filter((entry) => entry.status !== "rejected").map((entry) => entry.email));
  const steps = [
    ["Cadastros", scope.length],
    ["Voltaram a entrar", scope.filter((user) => (user.login_count || 0) > 1).length],
    ["Salvaram chave Pix", scope.filter((user) => user.pix_key).length],
    ["Compraram plano", scope.filter((user) => user.plan).length],
    ["Indicaram alguém", scope.filter((user) => referrers.has(user.email)).length],
    ["Sacaram", scope.filter((user) => withdrew.has(user.email)).length],
  ];
  return { steps: steps.map(([label, value]) => ({ label, value, percent: percent(value, scope.length) })) };
});

define("analytics.time_to_pay", group, "Tempo entre cadastro e compra", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  const delays = users.filter((user) => user.plan && user.plan_activated_at).map((user) => to_ms(user.plan_activated_at) - created_ms(user)).filter((value) => value >= 0);
  const buckets = [["até 5 min", 300000], ["até 1 h", 3600000], ["até 24 h", day_ms], ["até 7 dias", 7 * day_ms], ["até 30 dias", 30 * day_ms], ["mais de 30 dias", Infinity]];
  const sorted = [...delays].sort((a, b) => a - b);
  return { buckets: buckets.map(([label, limit], index) => ({ label, value: delays.filter((delay) => delay <= limit && delay > (buckets[index - 1]?.[1] ?? -1)).length })), median_seconds: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] / 1000) : null, sample: delays.length };
});

define("analytics.cohorts", group, "Coortes mensais (cadastro → compra)", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  const groups = {};
  for (const user of users) {
    const key = brt_month(created_ms(user));
    groups[key] = groups[key] || { month: key, signups: 0, paying: 0, returned: 0 };
    groups[key].signups++;
    if (user.plan) groups[key].paying++;
    if ((user.login_count || 0) > 1) groups[key].returned++;
  }
  return { rows: Object.values(groups).sort((a, b) => a.month.localeCompare(b.month)).map((entry) => ({ ...entry, conversion: percent(entry.paying, entry.signups), return_rate: percent(entry.returned, entry.signups) })) };
});

define("analytics.active_users", group, "Usuários ativos por dia", { roles: staff.everyone, read: true, fields: [days_field] }, async (ctx, input) => {
  const days = clamp_days(input.days);
  const logins = await load_logs(["login", "signup"]);
  const per_day = {};
  for (const log of logins) {
    const key = brt_day(log.ts);
    per_day[key] = per_day[key] || new Set();
    per_day[key].add(log.email);
  }
  const series = Array.from({ length: days }, (_, index) => {
    const label = brt_day(Date.now() - (days - 1 - index) * day_ms);
    return { label, value: per_day[label]?.size || 0 };
  });
  const distinct = (span) => new Set(logins.filter((log) => log.ts >= Date.now() - span * day_ms).map((log) => log.email)).size;
  return { series, dau: distinct(1), wau: distinct(7), mau: distinct(30) };
});

define("analytics.retention", group, "Retenção semanal", { roles: staff.everyone, read: true, fields: [field.number("weeks", "Semanas", { default: 8 })] }, async (ctx, input) => {
  const { users } = await load_all();
  const logs = await load_logs(["login"]);
  const weeks = Math.min(26, Math.max(2, input.weeks));
  const week_ms = 7 * day_ms;
  const now = Date.now();
  const seen = new Map();
  for (const log of logs) seen.set(log.email, [...(seen.get(log.email) || []), log.ts]);
  const rows = Array.from({ length: weeks }, (_, index) => {
    const start = now - (weeks - index) * week_ms;
    const cohort = users.filter((user) => created_ms(user) >= start && created_ms(user) < start + week_ms);
    const returned = (span) => cohort.filter((user) => (seen.get(user.email) || []).some((time) => time >= created_ms(user) + span * day_ms && time < created_ms(user) + (span + 7) * day_ms)).length;
    return { week: brt_day(start), size: cohort.length, d7: percent(returned(7), cohort.length), d14: percent(returned(14), cohort.length), d28: percent(returned(28), cohort.length) };
  });
  return { rows };
});

define("analytics.referral_leaderboard", group, "Ranking de indicadores", { roles: staff.everyone, read: true, fields: [field.number("limit", "Quantidade", { default: 25 })] }, async (ctx, input) => {
  const { users } = await load_all();
  const stats = {};
  for (const user of users.filter((entry) => entry.referred_by)) {
    stats[user.referred_by] = stats[user.referred_by] || { email: user.referred_by, referrals: 0, paying: 0 };
    stats[user.referred_by].referrals++;
    if (user.plan) stats[user.referred_by].paying++;
  }
  const rows = Object.values(stats).map((entry) => ({ ...entry, conversion: percent(entry.paying, entry.referrals) })).sort((a, b) => b.paying - a.paying || b.referrals - a.referrals);
  return { rows: rows.slice(0, Math.min(100, input.limit)), referrers: rows.length };
});

define("analytics.balance_distribution", group, "Distribuição de saldos", { roles: staff.money, read: true }, async () => {
  const { users } = await load_all();
  const edges = [0, 1, 10, 25, 50, 100, 250, 500, 1000];
  const rows = edges.map((low, index) => {
    const high = edges[index + 1];
    const count = users.filter((user) => (user.balance || 0) >= low && (high === undefined || (user.balance || 0) < high)).length;
    return { label: high === undefined ? `R$ ${low}+` : `R$ ${low}–${high}`, value: count };
  });
  return { rows };
});

define("analytics.revenue_by_source", group, "Receita por origem", { roles: staff.money, read: true }, async () => {
  const { users } = await load_all();
  const totals = {};
  for (const user of users.filter((entry) => entry.plan)) totals[source_of(user)] = money((totals[source_of(user)] || 0) + user.plan);
  return { rows: ranked(totals, 50) };
});
