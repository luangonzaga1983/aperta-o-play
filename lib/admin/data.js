import { read_channel, read_logs } from "../store.js";
import { account_state } from "../gate.js";
import { field } from "./registry.js";

const brt_shift = 3 * 3600000;

export const money = (value) => Number(Number(value || 0).toFixed(2));
export const to_ms = (iso) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};
export const created_ms = (user) => to_ms(user.created_at) || user.msg_at || 0;
export const brt_day = (ms) => new Date(ms - brt_shift).toISOString().slice(0, 10);
export const brt_month = (ms) => brt_day(ms).slice(0, 7);
export const brt_hour = (ms) => new Date(ms - brt_shift).getUTCHours();
export const brt_weekday = (ms) => new Date(ms - brt_shift).getUTCDay();
export const day_start = (text) => Date.parse(`${text}T00:00:00-03:00`);
export const day_end = (text) => Date.parse(`${text}T23:59:59.999-03:00`);
export const within = (ms, from, to) => (!from || ms >= day_start(from)) && (!to || ms <= day_end(to));
export const count_by = (rows, key_of) => rows.reduce((acc, row) => {
  const key = key_of(row) || "desconhecido";
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
export const ranked = (counts, limit = 20) => Object.entries(counts).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, limit);
export const text_has = (value, query) => String(value ?? "").toLowerCase().includes(query);
export const approved = (payment) => payment.status === "approved";

export async function load_all() {
  const [users, payments, withdrawals, commissions] = await Promise.all(["users", "payments", "withdrawals", "commissions"].map((key) => read_channel(key)));
  return { users, payments, withdrawals, commissions };
}

export const load_logs = (types) => read_logs(types ? (row) => types.includes(row.type) : undefined);

export function safe_user(user) {
  const { password_hash, ...rest } = user;
  return { ...rest, has_password: !!password_hash, state: account_state(user), created_ms: created_ms(user), snowflake_ms: user.msg_at };
}

export function user_row(user, referral_counts = {}) {
  return {
    email: user.email,
    msg_id: user.msg_id,
    whatsapp: user.whatsapp || null,
    name: user.name || null,
    plan: user.plan || null,
    balance: money(user.balance),
    state: account_state(user),
    role: user.adm?.role || null,
    tags: user.adm?.tags || [],
    withdraw_blocked: !!user.adm?.withdraw_blocked,
    google: !!user.google,
    has_pix: !!user.pix_key,
    auto_payout: !!user.auto_payout,
    referral_code: user.referral_code || null,
    referred_by: user.referred_by || null,
    referrals: referral_counts[user.email] || 0,
    created_at: user.created_at || null,
    created_ms: created_ms(user),
    plan_activated_at: user.plan_activated_at || null,
    reg_ip: user.reg?.ip || null,
    reg_country: user.reg?.cc || null,
    reg_city: user.reg?.ct || null,
    reg_device: user.reg?.dv || null,
    last_login_at: user.last?.at || null,
    last_ip: user.last?.ip || null,
    last_country: user.last?.cc || null,
    logins: user.login_count || 0,
  };
}

export const referral_counts = (users) => count_by(users.filter((user) => user.referred_by), (user) => user.referred_by);

export function sort_rows(rows, accessors, input, fallback) {
  const access = accessors[input.sort] || accessors[fallback];
  if (!access) return rows;
  const direction = input.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = access(a);
    const right = access(b);
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return (left > right ? 1 : -1) * direction;
  });
}

export function paginate(rows, input) {
  const per_page = Math.min(200, Math.max(1, Number(input.per_page) || 25));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / per_page));
  const page = Math.min(pages, Math.max(1, Number(input.page) || 1));
  return { rows: rows.slice((page - 1) * per_page, page * per_page), total, page, pages, per_page };
}

export const paging_fields = [
  field.number("page", "Página", { default: 1 }),
  field.number("per_page", "Por página", { default: 25 }),
  field.text("sort", "Ordenar por"),
  field.select("dir", "Direção", [{ value: "desc", label: "Decrescente" }, { value: "asc", label: "Crescente" }], { default: "desc" }),
];

export const range_fields = [
  field.date("from", "De"),
  field.date("to", "Até"),
];

const csv_cell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function csv_file(name, rows, columns) {
  const header = columns.map(([title]) => csv_cell(title)).join(",");
  const lines = rows.map((row) => columns.map(([, read]) => csv_cell(read(row))).join(","));
  return { download: { filename: `${name}-${new Date().toISOString().slice(0, 10)}.csv`, mime: "text/csv;charset=utf-8", content: `﻿${[header, ...lines].join("\n")}` }, count: rows.length };
}

export function series_by_day(rows, ms_of, value_of, days) {
  const end = Date.now();
  const totals = {};
  for (const row of rows) {
    const key = brt_day(ms_of(row));
    totals[key] = (totals[key] || 0) + value_of(row);
  }
  return Array.from({ length: days }, (_, index) => {
    const key = brt_day(end - (days - 1 - index) * 86400000);
    return { label: key, value: money(totals[key] || 0) };
  });
}

export function build_timeline(email, all, logs) {
  const events = [];
  const user = all.users.find((entry) => entry.email === email);
  if (user) events.push({ ts: created_ms(user), kind: "signup", title: "Conta criada", detail: user.reg ? `${user.reg.ip || "?"} · ${user.reg.ct || ""} ${user.reg.cc || ""} · ${user.reg.br || ""} / ${user.reg.os || ""}` : "" });
  for (const payment of all.payments.filter((entry) => entry.email === email)) events.push({ ts: to_ms(payment.created_at) || payment.msg_at, kind: "payment", title: `Pix gerado R$ ${payment.plan_price}`, detail: payment.status });
  for (const payment of all.payments.filter((entry) => entry.email === email && entry.paid_at)) events.push({ ts: to_ms(payment.paid_at), kind: "payment_paid", title: `Pagamento confirmado R$ ${payment.plan_price}`, detail: payment.payment_id });
  for (const withdrawal of all.withdrawals.filter((entry) => entry.email === email)) events.push({ ts: to_ms(withdrawal.created_at) || withdrawal.msg_at, kind: "withdrawal", title: `Saque R$ ${withdrawal.amount}`, detail: withdrawal.status });
  for (const commission of all.commissions.filter((entry) => entry.affiliate === email)) events.push({ ts: to_ms(commission.created_at) || commission.msg_at, kind: "commission", title: `Comissão R$ ${commission.amount}`, detail: `de ${commission.from_user}` });
  for (const log of logs.filter((entry) => entry.email === email || entry.target === email)) events.push({ ts: log.ts || log.msg_at, kind: log.type, title: describe_log(log), detail: [log.ip, log.ct, log.cc, log.browser, log.os].filter(Boolean).join(" · ") });
  return events.sort((a, b) => b.ts - a.ts);
}

export function describe_log(log) {
  if (log.type === "login") return "Login";
  if (log.type === "login_failed") return `Login falhou (${log.reason || "?"})`;
  if (log.type === "signup") return "Cadastro";
  if (log.type === "audit") return `Admin ${log.actor}: ${log.action}`;
  if (log.type === "note") return `Nota de ${log.actor}: ${log.text}`;
  if (log.type === "ledger") return `Ajuste de saldo ${log.delta > 0 ? "+" : ""}${log.delta} (${log.reason || ""})`;
  return log.type;
}
