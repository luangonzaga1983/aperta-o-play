import { define, field, staff, c_admin_error } from "./registry.js";
import { load_all, load_logs, paginate, paging_fields, range_fields, csv_file, to_ms, within, text_has, count_by, ranked } from "./data.js";
import { channels, channel_probe, channel_ready, read_channel, get_settings, set_config, list_config, post_row, delete_row, default_settings, invalidate, fit_content } from "../store.js";
import { mp, PAYOUTS_ENABLED, MAX_AUTO_WITHDRAW, GOOGLE_CLIENT_ID } from "../mercadopago.js";

const group = "Sistema";

const audit_types = ["audit", "audit_denied"];

const audit_rows = (logs, input) => {
  const query = String(input.q || "").toLowerCase();
  return logs.filter((log) => {
    if (input.actor && log.actor !== input.actor.toLowerCase()) return false;
    if (input.action && !String(log.action || "").startsWith(input.action)) return false;
    if (input.only_denied && log.type !== "audit_denied") return false;
    if (query && ![log.target, log.input, log.action, log.actor].some((value) => text_has(value, query))) return false;
    return within(log.ts || log.msg_at, input.from, input.to);
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0));
};

const audit_filters = [
  field.text("q", "Busca (alvo, ação, dados)"),
  field.email("actor", "Admin"),
  field.text("action", "Ação começa com (ex: users.)"),
  field.checkbox("only_denied", "Somente acessos negados"),
  ...range_fields,
];

define("audit.list", group, "Log de auditoria (quem fez o quê)", { roles: staff.admin, read: true, fields: [...audit_filters, ...paging_fields.slice(0, 2)] }, async (ctx, input) => paginate(audit_rows(await load_logs(audit_types), input), input));

define("audit.export_csv", group, "Exportar auditoria (CSV)", { roles: staff.admin, fields: audit_filters }, async (ctx, input) => csv_file("auditoria", audit_rows(await load_logs(audit_types), input), [["quando", (r) => r.at], ["admin", (r) => r.actor], ["cargo", (r) => r.role], ["acao", (r) => r.action], ["alvo", (r) => r.target], ["dados", (r) => r.input], ["ip", (r) => r.ip], ["resultado", (r) => r.type === "audit" ? "ok" : "negado"]]));

define("audit.summary", group, "Atividade da equipe", { roles: staff.admin, read: true, fields: [field.number("days", "Dias", { default: 30 })] }, async (ctx, input) => {
  const limit = Date.now() - input.days * 86400000;
  const rows = (await load_logs(audit_types)).filter((log) => log.ts >= limit);
  return { total: rows.length, by_admin: ranked(count_by(rows, (row) => row.actor)), by_action: ranked(count_by(rows, (row) => row.action), 25), denied: rows.filter((row) => row.type === "audit_denied").length };
});

define("logs.browse", group, "Navegar nos eventos brutos", { roles: staff.admin, read: true, fields: [field.select("type", "Tipo", [{ value: "", label: "Todos" }, ...["signup", "login", "login_failed", "note", "ledger", "plan_change", "user_deleted", "audit", "audit_denied"].map((value) => ({ value, label: value }))]), field.text("q", "Busca"), ...paging_fields.slice(0, 2)] }, async (ctx, input) => {
  const query = String(input.q || "").toLowerCase();
  const rows = (await load_logs()).filter((log) => (!input.type || log.type === input.type) && (!query || JSON.stringify(log).toLowerCase().includes(query)));
  return paginate(rows, input);
});

define("system.health", group, "Saúde do sistema e variáveis de ambiente", { roles: staff.admin, read: true }, async () => {
  const keys = ["users", "payments", "withdrawals", "commissions", "logs", "config"];
  const probes = await Promise.all(keys.map(async (key) => ({ channel: key, ...(await channel_probe(key)) })));
  const mp_check = await mp("GET", "/users/me").then((account) => ({ ok: true, id: account.id, nickname: account.nickname, site: account.site_id })).catch((error) => ({ ok: false, error: error.message }));
  const env = {
    DISCORD_BOT_TOKEN: !!process.env.DISCORD_BOT_TOKEN,
    MP_ACCESS_TOKEN: !!process.env.MP_ACCESS_TOKEN,
    ADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
    MP_WEBHOOK_SECRET: !!process.env.MP_WEBHOOK_SECRET,
    GOOGLE_CLIENT_ID: !!GOOGLE_CLIENT_ID,
    MP_PAYOUTS_PRIVATE_KEY: PAYOUTS_ENABLED,
    DISCORD_CHANNEL_LOGS: !!channels.logs,
    DISCORD_CHANNEL_CONFIG: !!channels.config,
    SITE_URL: !!process.env.SITE_URL,
  };
  return { channels: probes, mercadopago: mp_check, env, payouts: { enabled: PAYOUTS_ENABLED, max_auto_withdraw: MAX_AUTO_WITHDRAW }, node: process.version, region: process.env.VERCEL_REGION || null, now: new Date().toISOString() };
});

define("system.channel_stats", group, "Tamanho de cada canal do Discord", { roles: staff.admin, read: true }, async () => {
  const rows = [];
  for (const key of ["users", "payments", "withdrawals", "commissions", "logs", "config"]) {
    if (!channel_ready(key)) { rows.push({ channel: key, configured: false }); continue; }
    const items = await read_channel(key, { fresh: true });
    rows.push({ channel: key, configured: true, records: items.length, newest: items.length ? Math.max(...items.map((item) => item.msg_at)) : null, oldest: items.length ? Math.min(...items.map((item) => item.msg_at)) : null });
  }
  return { rows };
});

define("system.record_sizes", group, "Registros de usuário perto do limite do Discord", { roles: staff.admin, read: true }, async () => {
  const { users } = await load_all();
  const rows = users.map((user) => ({ email: user.email, size: JSON.stringify((({ msg_id, msg_at, ...rest }) => rest)(user)).length })).sort((a, b) => b.size - a.size).slice(0, 30);
  return { rows, limit: 2000, near_limit: rows.filter((row) => row.size > 1700).length };
});

define("system.mp_account", group, "Conta do Mercado Pago conectada", { roles: staff.admin, read: true }, async () => {
  const account = await mp("GET", "/users/me");
  return { id: account.id, nickname: account.nickname, email: account.email, site: account.site_id, country: account.country_id, status: account.status?.site_status };
});

define("system.settings_get", group, "Configurações do site", { roles: staff.everyone, read: true }, async () => ({ settings: await get_settings(), defaults: default_settings, storage: channel_ready("config") }));

define("system.settings_set", group, "Alterar configurações do site", { roles: staff.admin, sudo: true, danger: true, fields: [
  field.checkbox("signups_open", "Cadastros abertos"),
  field.checkbox("withdrawals_open", "Saques abertos"),
  field.checkbox("maintenance", "Modo manutenção (bloqueia novos cadastros e mostra aviso)"),
  field.text("maintenance_message", "Mensagem de manutenção", { max: 200 }),
  field.number("min_withdraw", "Saque mínimo (R$)", { default: 1 }),
  field.number("max_withdraw", "Saque máximo por pedido (R$, 0 = sem limite)", { default: 0 }),
  field.number("max_accounts_per_ip", "Máx. contas por IP (0 = sem limite)", { default: 0 }),
  field.text("support_whatsapp", "WhatsApp do suporte (mostrado no site)", { max: 20 }),
] }, async (ctx, input) => {
  if (!channel_ready("config")) throw new c_admin_error("Defina DISCORD_CHANNEL_CONFIG para salvar configurações", 400);
  const next = { ...(await get_settings()), ...input };
  await set_config("settings", next);
  return { settings: next };
});

define("announcements.list", group, "Avisos publicados", { roles: staff.everyone, read: true }, async () => ({ rows: (await list_config("announcement")).sort((a, b) => b.msg_at - a.msg_at) }));

define("announcements.create", group, "Publicar aviso para os usuários", { roles: staff.admin, fields: [
  field.text("title", "Título", { required: true, max: 80 }),
  field.textarea("text", "Mensagem", { required: true, max: 500 }),
  field.select("level", "Tipo", [{ value: "info", label: "Informação" }, { value: "success", label: "Novidade" }, { value: "warn", label: "Atenção" }], { default: "info" }),
  field.email("target", "Só para este e-mail (vazio = todos)"),
  field.datetime("expires_at", "Expira em"),
] }, async (ctx, input) => {
  if (!channel_ready("config")) throw new c_admin_error("Defina DISCORD_CHANNEL_CONFIG para publicar avisos", 400);
  const row = await post_row("config", { type: "announcement", title: input.title, text: input.text, level: input.level, target: input.target || undefined, expires_at: input.expires_at || undefined, created_by: ctx.actor.email, created_at: new Date().toISOString() });
  return { id: row.msg_id };
});

define("announcements.delete", group, "Apagar aviso", { roles: staff.admin, fields: [field.text("id", "ID do aviso", { required: true })] }, async (ctx, input) => {
  await delete_row("config", input.id);
  return { ok: true };
});

define("system.backup", group, "Backup completo (JSON)", { roles: staff.owner, sudo: true, description: "Baixa usuários (sem hash de senha), pagamentos, saques e comissões." }, async () => {
  const all = await load_all();
  const content = JSON.stringify({ generated_at: new Date().toISOString(), users: all.users.map(({ password_hash, ...user }) => user), payments: all.payments, withdrawals: all.withdrawals, commissions: all.commissions }, null, 1);
  return { download: { filename: `backup-apertaoplay-${new Date().toISOString().slice(0, 10)}.json`, mime: "application/json", content }, bytes: content.length };
});

define("system.cache_clear", group, "Limpar cache de leitura", { roles: staff.admin }, async () => {
  invalidate();
  return { ok: true };
});

define("system.whoami", group, "Minha sessão de administrador", { roles: staff.everyone, read: true }, async (ctx) => ({ email: ctx.actor.email, role: ctx.role, ip: ctx.context.ip, country: ctx.context.cc, device: `${ctx.context.browser} / ${ctx.context.os}` }));

define("system.fit_check", group, "Testar se um texto cabe no limite do Discord", { roles: staff.admin, read: true, fields: [field.textarea("text", "Texto", { required: true })] }, async (ctx, input) => {
  try {
    return { fits: fit_content({ text: input.text }).length <= 2000, size: JSON.stringify({ text: input.text }).length };
  } catch {
    return { fits: false, size: JSON.stringify({ text: input.text }).length };
  }
});
