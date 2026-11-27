import { define, field, staff, c_admin_error } from "./registry.js";
import { load_all, load_logs, paginate, paging_fields, money, to_ms, created_ms, user_row, ranked, count_by, text_has } from "./data.js";
import { get_blocklist, set_config } from "../store.js";
import { account_state } from "../gate.js";

const group = "Segurança";
const day_ms = 86400000;
const list_names = { ip: "ips", email: "emails", domain: "domains", fingerprint: "fps" };

function clusters(users, key_of, label) {
  const groups = new Map();
  for (const user of users) {
    const keys = key_of(user);
    for (const key of keys) groups.set(key, [...(groups.get(key) || []), user]);
  }
  return [...groups.entries()].filter(([, members]) => members.length >= 2).map(([key, members]) => ({ kind: label, key, count: members.length, paying: members.filter((member) => member.plan).length, accounts: members.slice(0, 15).map((member) => member.email) })).sort((a, b) => b.count - a.count);
}

define("security.multi_accounts", group, "Contas ligadas (mesmo IP, aparelho, WhatsApp ou Pix)", { roles: staff.care, read: true, fields: [field.select("by", "Critério", [{ value: "all", label: "Todos" }, { value: "ip", label: "IP" }, { value: "fingerprint", label: "Aparelho" }, { value: "whatsapp", label: "WhatsApp" }, { value: "pix", label: "Chave Pix" }], { default: "all" }), ...paging_fields.slice(0, 2)] }, async (ctx, input) => {
  const { users } = await load_all();
  const groups = {
    ip: () => clusters(users, (user) => [...new Set([user.reg?.ip, user.last?.ip].filter(Boolean))], "ip"),
    fingerprint: () => clusters(users, (user) => [...new Set([user.reg?.fp, user.last?.fp].filter(Boolean))], "aparelho"),
    whatsapp: () => clusters(users, (user) => user.whatsapp ? [user.whatsapp] : [], "whatsapp"),
    pix: () => clusters(users, (user) => user.pix_key ? [user.pix_key] : [], "chave pix"),
  };
  const rows = (input.by === "all" ? Object.values(groups).flatMap((build) => build()) : groups[input.by]()).sort((a, b) => b.count - a.count);
  return paginate(rows, input);
});

define("security.ip_lookup", group, "Tudo sobre um IP", { roles: staff.care, read: true, fields: [field.text("ip", "IP", { required: true })] }, async (ctx, input) => {
  const [{ users }, logs] = await Promise.all([load_all(), load_logs(["login", "signup", "login_failed"])]);
  const events = logs.filter((log) => log.ip === input.ip);
  return {
    users: users.filter((user) => user.reg?.ip === input.ip || user.last?.ip === input.ip).map((user) => user_row(user)),
    events: events.slice(0, 100),
    accounts_seen: [...new Set(events.map((event) => event.email).filter(Boolean))],
    failures: events.filter((event) => event.type === "login_failed").length,
  };
});

define("security.fingerprint_lookup", group, "Tudo sobre um aparelho (fingerprint)", { roles: staff.care, read: true, fields: [field.text("fp", "Fingerprint", { required: true })] }, async (ctx, input) => {
  const [{ users }, logs] = await Promise.all([load_all(), load_logs(["login", "signup", "login_failed"])]);
  const events = logs.filter((log) => log.fp === input.fp);
  return { users: users.filter((user) => user.reg?.fp === input.fp || user.last?.fp === input.fp).map((user) => user_row(user)), events: events.slice(0, 100) };
});

define("security.failed_logins", group, "Tentativas de login que falharam", { roles: staff.care, read: true, fields: [field.text("q", "E-mail ou IP"), ...paging_fields.slice(0, 2)] }, async (ctx, input) => {
  const logs = await load_logs(["login_failed"]);
  const query = String(input.q || "").toLowerCase();
  return paginate(logs.filter((log) => !query || [log.email, log.ip].some((value) => text_has(value, query))).sort((a, b) => b.ts - a.ts), input);
});

define("security.brute_force", group, "Ataques de força bruta (muitas falhas)", { roles: staff.care, read: true, fields: [field.number("hours", "Janela (horas)", { default: 24 }), field.number("min", "Mínimo de falhas", { default: 5 })] }, async (ctx, input) => {
  const limit = Date.now() - input.hours * 3600000;
  const failures = (await load_logs(["login_failed"])).filter((log) => log.ts >= limit);
  const by_ip = Object.entries(count_by(failures, (log) => log.ip)).filter(([, count]) => count >= input.min);
  const by_email = Object.entries(count_by(failures, (log) => log.email)).filter(([, count]) => count >= input.min);
  return { ips: by_ip.map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value), emails: by_email.map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value), total_failures: failures.length };
});

define("security.logins_by_hour", group, "Acessos nas últimas 24 horas", { roles: staff.care, read: true }, async () => {
  const logs = await load_logs(["login", "login_failed"]);
  const now = Date.now();
  const series = Array.from({ length: 24 }, (_, index) => {
    const start = now - (24 - index) * 3600000;
    const inside = logs.filter((log) => log.ts >= start && log.ts < start + 3600000);
    return { label: `${String(new Date(start - 3 * 3600000).getUTCHours()).padStart(2, "0")}h`, ok: inside.filter((log) => log.type === "login").length, failed: inside.filter((log) => log.type === "login_failed").length };
  });
  return { series };
});

define("security.risky_withdrawals", group, "Saques em aberto com sinais de risco", { roles: staff.money, read: true }, async () => {
  const { users, withdrawals } = await load_all();
  const open = withdrawals.filter((withdrawal) => withdrawal.status === "pending" || withdrawal.status === "processing");
  const rows = open.map((withdrawal) => {
    const user = users.find((entry) => entry.email === withdrawal.email);
    const flags = [];
    if (!user) flags.push("usuário inexistente");
    if (user && Date.now() - created_ms(user) < 3 * day_ms) flags.push("conta com menos de 3 dias");
    if (user && account_state(user) !== "active") flags.push(`conta ${account_state(user)}`);
    if (user?.adm?.withdraw_blocked) flags.push("saque bloqueado");
    if (user && !user.plan) flags.push("sem plano");
    if (users.some((entry) => entry.email !== withdrawal.email && entry.pix_key && entry.pix_key === withdrawal.pix_key)) flags.push("chave Pix usada por outra conta");
    if (user && users.some((entry) => entry.email !== user.email && user.reg?.ip && entry.reg?.ip === user.reg.ip)) flags.push("mesmo IP de outra conta");
    if (user && user.last?.cc && user.reg?.cc && user.last.cc !== user.reg.cc) flags.push("país mudou desde o cadastro");
    if (withdrawal.amount >= 200) flags.push("valor alto");
    return { id: withdrawal.msg_id, email: withdrawal.email, amount: money(withdrawal.amount), status: withdrawal.status, created_at: withdrawal.created_at, flags, score: flags.length };
  }).sort((a, b) => b.score - a.score);
  return { rows };
});

define("security.banned_users", group, "Usuários banidos e suspensos", { roles: staff.care, read: true }, async () => {
  const { users } = await load_all();
  return { rows: users.filter((user) => account_state(user) !== "active").map((user) => ({ ...user_row(user), reason: user.adm?.ban_reason || null, banned_at: user.adm?.banned_at || null, banned_by: user.adm?.banned_by || null, suspended_until: user.adm?.suspended_until || null })) };
});

define("security.new_countries", group, "Acessos de país diferente do cadastro", { roles: staff.care, read: true, fields: paging_fields.slice(0, 2) }, async (ctx, input) => {
  const { users } = await load_all();
  return paginate(users.filter((user) => user.reg?.cc && user.last?.cc && user.reg.cc !== user.last.cc).map((user) => ({ ...user_row(user), registered_country: user.reg.cc, last_country_seen: user.last.cc })), input);
});

define("security.top_ips", group, "IPs com mais contas", { roles: staff.care, read: true }, async () => {
  const { users } = await load_all();
  return { rows: ranked(count_by(users.filter((user) => user.reg?.ip), (user) => user.reg.ip), 30) };
});

define("security.blocklist", group, "Lista de bloqueios (IP, e-mail, domínio, aparelho)", { roles: staff.care, read: true }, async () => ({ blocklist: await get_blocklist() }));

define("security.block_add", group, "Adicionar bloqueio", { roles: staff.admin, sudo: true, danger: true, fields: [field.select("kind", "Tipo", [{ value: "ip", label: "IP" }, { value: "email", label: "E-mail" }, { value: "domain", label: "Domínio de e-mail" }, { value: "fingerprint", label: "Aparelho (fingerprint)" }], { required: true }), field.text("value", "Valor", { required: true, max: 80 })] }, async (ctx, input) => {
  const list = await get_blocklist();
  const name = list_names[input.kind];
  const value = input.kind === "ip" ? input.value : input.value.toLowerCase();
  if (list[name].includes(value)) throw new c_admin_error("Já está na lista");
  const next = { ...list, [name]: [...list[name], value] };
  if (JSON.stringify(next).length > 1800) throw new c_admin_error("A lista de bloqueios está cheia (limite do Discord)");
  await set_config("blocklist", next);
  return { blocklist: next };
});

define("security.block_remove", group, "Remover bloqueio", { roles: staff.admin, sudo: true, fields: [field.select("kind", "Tipo", [{ value: "ip", label: "IP" }, { value: "email", label: "E-mail" }, { value: "domain", label: "Domínio de e-mail" }, { value: "fingerprint", label: "Aparelho (fingerprint)" }], { required: true }), field.text("value", "Valor", { required: true })] }, async (ctx, input) => {
  const list = await get_blocklist();
  const name = list_names[input.kind];
  const next = { ...list, [name]: list[name].filter((entry) => entry !== input.value && entry !== input.value.toLowerCase()) };
  await set_config("blocklist", next);
  return { blocklist: next };
});

define("security.stale_sessions_overview", group, "Contas com sessões encerradas por admin", { roles: staff.care, read: true }, async () => {
  const { users } = await load_all();
  return { rows: users.filter((user) => user.adm?.valid_after).map((user) => ({ email: user.email, valid_after: user.adm.valid_after, ago_hours: Math.round((Date.now() - user.adm.valid_after) / 360000) / 10 })).sort((a, b) => b.valid_after - a.valid_after).slice(0, 100) };
});
