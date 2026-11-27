import { randomBytes } from "node:crypto";
import { define, field, staff, email_field, reason_field, c_admin_error } from "./registry.js";
import {
  load_all, load_logs, safe_user, user_row, referral_counts, sort_rows, paginate, paging_fields, range_fields,
  csv_file, money, to_ms, created_ms, within, text_has, build_timeline, count_by, ranked,
} from "./data.js";
import { find_user, save_user, patch_row, get_row, delete_row, post_row, log_event, invalidate } from "../store.js";
import { account_state } from "../gate.js";
import {
  hash_password, make_token, norm_phone, valid_pix_key, normalize_pix_key, valid_doc, only_digits, PIX_TYPES, PLANS, activate_user_plan,
} from "../mercadopago.js";

const group = "Usuários";
const plan_options = PLANS.map((plan) => ({ value: String(plan.price), label: `R$ ${plan.price}` }));
const pix_type_options = ["cpf", "cnpj", "email", "phone", "random"].map((value) => ({ value, label: value.toUpperCase() }));
const yes_no = (label) => field.select(label.name, label.title, [{ value: "", label: "Todos" }, { value: "yes", label: "Sim" }, { value: "no", label: "Não" }]);
const referral_alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const clean_adm = (adm) => {
  const entries = Object.entries(adm).filter(([, value]) => !(value === undefined || value === null || value === false || value === "" || (Array.isArray(value) && value.length === 0)));
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const adm_patch = (user, patch) => ({ adm: clean_adm({ ...user.adm, ...patch }) });

const random_code = (length) => Array.from(randomBytes(length), (byte) => referral_alphabet[byte % referral_alphabet.length]).join("");

const random_password = () => Array.from(randomBytes(10), (byte) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 56]).join("");

export async function require_user(email) {
  const user = await find_user(email, { fresh: true });
  if (!user) throw new c_admin_error("Usuário não encontrado", 404);
  return user;
}

const related_to = (all, email) => ({
  payments: all.payments.filter((entry) => entry.email === email),
  withdrawals: all.withdrawals.filter((entry) => entry.email === email),
  earned: all.commissions.filter((entry) => entry.affiliate === email),
  generated: all.commissions.filter((entry) => entry.from_user === email),
  referrals: all.users.filter((entry) => entry.referred_by === email),
});

const aggregate = (events, key_of, shape) => {
  const groups = new Map();
  for (const event of events) {
    const key = key_of(event);
    if (!key) continue;
    const current = groups.get(key) || { ...shape(event), count: 0, first_ts: event.ts, last_ts: event.ts };
    current.count++;
    current.first_ts = Math.min(current.first_ts, event.ts);
    current.last_ts = Math.max(current.last_ts, event.ts);
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.last_ts - a.last_ts);
};

const access_history = (logs, email) => {
  const events = logs.filter((log) => log.email === email && (log.type === "login" || log.type === "signup")).sort((a, b) => b.ts - a.ts);
  return {
    events: events.slice(0, 60),
    ips: aggregate(events, (event) => event.ip, (event) => ({ ip: event.ip, country: event.cc, region: event.rg, city: event.ct })),
    devices: aggregate(events, (event) => `${event.fp || ""}|${event.browser}|${event.os}`, (event) => ({ fp: event.fp, browser: event.browser, os: event.os, device: event.device, screen: event.scr })),
  };
};

const shared_accounts = (user, users) => users
  .filter((other) => other.email !== user.email)
  .map((other) => {
    const reasons = [];
    const ips = new Set([user.reg?.ip, user.last?.ip].filter(Boolean));
    if (ips.size && (ips.has(other.reg?.ip) || ips.has(other.last?.ip))) reasons.push(["ip", 2]);
    if (user.reg?.fp && (other.reg?.fp === user.reg.fp || other.last?.fp === user.reg.fp)) reasons.push(["dispositivo", 3]);
    if (user.whatsapp && other.whatsapp === user.whatsapp) reasons.push(["whatsapp", 4]);
    if (user.pix_key && other.pix_key === user.pix_key) reasons.push(["chave pix", 5]);
    if (user.owner_doc && other.owner_doc === user.owner_doc) reasons.push(["cpf do titular", 5]);
    return { email: other.email, plan: other.plan || null, state: account_state(other), reasons: reasons.map(([name]) => name), score: reasons.reduce((sum, [, weight]) => sum + weight, 0), created_ms: created_ms(other) };
  })
  .filter((entry) => entry.score > 0)
  .sort((a, b) => b.score - a.score);

function filter_users(users, input) {
  const query = String(input.q || "").toLowerCase();
  return users.filter((user) => {
    if (query && ![user.email, user.whatsapp, user.referral_code, user.pix_key, user.owner_doc, user.name, user.reg?.ip, user.last?.ip, user.reg?.fp].some((value) => text_has(value, query))) return false;
    if (input.plan === "none" && user.plan) return false;
    if (input.plan && input.plan !== "none" && String(user.plan) !== input.plan) return false;
    if (input.state && account_state(user) !== input.state) return false;
    if (input.auth === "google" && !user.google) return false;
    if (input.auth === "password" && !user.password_hash) return false;
    if (input.has_pix === "yes" && !user.pix_key) return false;
    if (input.has_pix === "no" && user.pix_key) return false;
    if (input.referred === "yes" && !user.referred_by) return false;
    if (input.referred === "no" && user.referred_by) return false;
    if (input.role && (user.adm?.role || "") !== input.role) return false;
    if (input.tag && !(user.adm?.tags || []).includes(input.tag.toLowerCase())) return false;
    if (input.country && (user.reg?.cc || "") !== input.country.toUpperCase()) return false;
    if (input.balance_min !== undefined && money(user.balance) < input.balance_min) return false;
    if (input.balance_max !== undefined && money(user.balance) > input.balance_max) return false;
    if (input.never_logged && user.login_count) return false;
    if (input.withdraw_blocked && !user.adm?.withdraw_blocked) return false;
    return within(created_ms(user), input.from, input.to);
  });
}

const filter_fields = [
  field.text("q", "Busca (e-mail, WhatsApp, código, Pix, IP, nome)"),
  field.select("plan", "Plano", [{ value: "", label: "Todos" }, { value: "none", label: "Sem plano" }, ...plan_options]),
  field.select("state", "Situação", [{ value: "", label: "Todas" }, { value: "active", label: "Ativa" }, { value: "suspended", label: "Suspensa" }, { value: "banned", label: "Banida" }]),
  field.select("auth", "Login", [{ value: "", label: "Todos" }, { value: "google", label: "Google" }, { value: "password", label: "Senha" }]),
  yes_no({ name: "has_pix", title: "Tem chave Pix" }),
  yes_no({ name: "referred", title: "Veio por indicação" }),
  field.select("role", "Cargo", [{ value: "", label: "Todos" }, { value: "admin", label: "Admin" }, { value: "support", label: "Suporte" }, { value: "finance", label: "Financeiro" }]),
  field.text("tag", "Tag"),
  field.text("country", "País (ex: BR)", { max: 2 }),
  field.number("balance_min", "Saldo mínimo"),
  field.number("balance_max", "Saldo máximo"),
  field.checkbox("never_logged", "Nunca fez login"),
  field.checkbox("withdraw_blocked", "Saque bloqueado"),
  ...range_fields,
];

const sorters = {
  created: (row) => row.created_ms,
  email: (row) => row.email,
  balance: (row) => row.balance,
  plan: (row) => row.plan || 0,
  last_login: (row) => to_ms(row.last_login_at),
  logins: (row) => row.logins,
  referrals: (row) => row.referrals,
};

define("users.list", group, "Listar usuários", { roles: staff.everyone, read: true, fields: [...filter_fields, ...paging_fields], description: "Busca, filtros e ordenação de todos os usuários." }, async (ctx, input) => {
  const { users } = await load_all();
  const counts = referral_counts(users);
  const rows = sort_rows(filter_users(users, input).map((user) => user_row(user, counts)), sorters, input, "created");
  return paginate(rows, input);
});

define("users.counts", group, "Contadores de usuários", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  const states = count_by(users, (user) => account_state(user));
  return { total: users.length, with_plan: users.filter((user) => user.plan).length, google: users.filter((user) => user.google).length, with_pix: users.filter((user) => user.pix_key).length, never_logged: users.filter((user) => !user.login_count).length, ...states, staff: users.filter((user) => user.adm?.role).length };
});

define("users.export_csv", group, "Exportar usuários (CSV)", { roles: staff.admin, read: false, fields: filter_fields, description: "Exporta os usuários filtrados." }, async (ctx, input) => {
  const { users } = await load_all();
  const counts = referral_counts(users);
  const rows = filter_users(users, input).map((user) => user_row(user, counts));
  return csv_file("usuarios", rows, [
    ["email", (r) => r.email], ["whatsapp", (r) => r.whatsapp], ["nome", (r) => r.name], ["plano", (r) => r.plan], ["saldo", (r) => r.balance],
    ["situacao", (r) => r.state], ["cargo", (r) => r.role], ["tags", (r) => r.tags.join("|")], ["indicado_por", (r) => r.referred_by], ["codigo", (r) => r.referral_code],
    ["indicados", (r) => r.referrals], ["criado_em", (r) => r.created_at], ["ip_cadastro", (r) => r.reg_ip], ["pais", (r) => r.reg_country], ["cidade", (r) => r.reg_city],
    ["dispositivo", (r) => r.reg_device], ["ultimo_login", (r) => r.last_login_at], ["ultimo_ip", (r) => r.last_ip], ["logins", (r) => r.logins],
  ]);
});

define("users.get", group, "Perfil completo do usuário", { roles: staff.everyone, read: true, target: "user", fields: [email_field] }, async (ctx, input) => {
  const all = await load_all();
  const user = await require_user(input.email);
  const logs = await load_logs();
  const related = related_to(all, user.email);
  const history = access_history(logs, user.email);
  const referrer = user.referred_by ? all.users.find((entry) => entry.email === user.referred_by) : null;
  return {
    user: safe_user(user),
    referrer: referrer ? user_row(referrer) : null,
    payments: related.payments,
    withdrawals: related.withdrawals,
    commissions_earned: related.earned,
    commissions_generated: related.generated,
    referrals: related.referrals.map((entry) => user_row(entry)),
    access: history,
    notes: logs.filter((log) => log.type === "note" && log.email === user.email),
    ledger: logs.filter((log) => log.type === "ledger" && log.email === user.email),
    duplicates: shared_accounts(user, all.users).slice(0, 20),
    totals: {
      paid: money(related.payments.filter((entry) => entry.status === "approved").reduce((sum, entry) => sum + (entry.plan_price || 0), 0)),
      withdrawn: money(related.withdrawals.filter((entry) => ["approved", "processing", "pending"].includes(entry.status)).reduce((sum, entry) => sum + entry.amount, 0)),
      earned: money(related.earned.filter((entry) => !entry.reverted).reduce((sum, entry) => sum + entry.amount, 0)),
    },
  };
});

define("users.timeline", group, "Linha do tempo do usuário", { roles: staff.everyone, read: true, target: "user", fields: [email_field] }, async (ctx, input) => {
  const [all, logs] = await Promise.all([load_all(), load_logs()]);
  return { events: build_timeline(input.email, all, logs).slice(0, 400) };
});

define("users.sessions", group, "Histórico de acessos (IP e dispositivo)", { roles: staff.everyone, read: true, target: "user", fields: [email_field] }, async (ctx, input) => ({ access: access_history(await load_logs(["login", "signup"]), input.email) }));

define("users.duplicates", group, "Contas relacionadas (multi-conta)", { roles: staff.everyone, read: true, target: "user", fields: [email_field] }, async (ctx, input) => {
  const { users } = await load_all();
  const user = users.find((entry) => entry.email === input.email);
  if (!user) throw new c_admin_error("Usuário não encontrado", 404);
  return { accounts: shared_accounts(user, users) };
});

define("users.lookup", group, "Busca global (e-mail, IP, Pix, pagamento...)", { roles: staff.everyone, read: true, fields: [field.text("query", "O que procurar", { required: true })] }, async (ctx, input) => {
  const all = await load_all();
  const query = input.query.toLowerCase();
  const digits = only_digits(input.query);
  const matches_user = (user) => [user.email, user.name, user.referral_code, user.pix_key, user.owner_doc, user.reg?.ip, user.last?.ip, user.reg?.fp, user.last?.fp, user.msg_id].some((value) => text_has(value, query)) || (digits.length >= 8 && only_digits(user.whatsapp).includes(digits));
  const counts = referral_counts(all.users);
  return {
    users: all.users.filter(matches_user).slice(0, 50).map((user) => user_row(user, counts)),
    payments: all.payments.filter((entry) => [entry.payment_id, entry.email, entry.msg_id].some((value) => text_has(value, query))).slice(0, 50),
    withdrawals: all.withdrawals.filter((entry) => [entry.email, entry.transfer_id, entry.ref, entry.pix_key, entry.msg_id].some((value) => text_has(value, query))).slice(0, 50),
  };
});

define("users.referrals", group, "Árvore de indicados", { roles: staff.everyone, read: true, target: "user", fields: [email_field, field.number("depth", "Profundidade (1-6)", { default: 3 })] }, async (ctx, input) => {
  const { users } = await load_all();
  const children = new Map();
  for (const user of users) if (user.referred_by) children.set(user.referred_by, [...(children.get(user.referred_by) || []), user]);
  const nodes = [];
  let level = [input.email];
  const seen = new Set(level);
  for (let depth = 1; depth <= Math.min(6, Math.max(1, input.depth)); depth++) {
    const next = [];
    for (const parent of level) {
      for (const child of children.get(parent) || []) {
        if (seen.has(child.email)) continue;
        seen.add(child.email);
        next.push(child.email);
        nodes.push({ ...user_row(child), level: depth, parent });
      }
    }
    level = next;
  }
  return { nodes, total: nodes.length, paying: nodes.filter((node) => node.plan).length };
});

define("users.upline", group, "Cadeia de quem indicou", { roles: staff.everyone, read: true, target: "user", fields: [email_field] }, async (ctx, input) => {
  const { users } = await load_all();
  const chain = [];
  const seen = new Set([input.email]);
  let current = users.find((user) => user.email === input.email);
  while (current?.referred_by && !seen.has(current.referred_by) && chain.length < 20) {
    seen.add(current.referred_by);
    current = users.find((user) => user.email === current.referred_by);
    if (current) chain.push(user_row(current));
  }
  return { chain };
});

define("users.recent", group, "Últimos cadastros / acessos", { roles: staff.everyone, read: true, fields: [field.select("kind", "Tipo", [{ value: "signups", label: "Cadastros" }, { value: "logins", label: "Acessos" }], { default: "signups" }), field.number("limit", "Quantidade", { default: 30 })] }, async (ctx, input) => {
  const { users } = await load_all();
  const counts = referral_counts(users);
  const ordered = input.kind === "logins" ? users.filter((user) => user.last?.at).sort((a, b) => to_ms(b.last.at) - to_ms(a.last.at)) : [...users].sort((a, b) => created_ms(b) - created_ms(a));
  return { rows: ordered.slice(0, Math.min(200, input.limit)).map((user) => user_row(user, counts)) };
});

define("users.inactive", group, "Usuários inativos", { roles: staff.everyone, read: true, fields: [field.number("days", "Sem acessar há (dias)", { default: 30 }), ...paging_fields.slice(0, 2)] }, async (ctx, input) => {
  const { users } = await load_all();
  const limit = Date.now() - input.days * 86400000;
  const rows = users.filter((user) => (to_ms(user.last?.at) || created_ms(user)) < limit).map((user) => user_row(user)).sort((a, b) => a.created_ms - b.created_ms);
  return paginate(rows, input);
});

define("users.top", group, "Ranking de usuários", { roles: staff.everyone, read: true, fields: [field.select("by", "Critério", [{ value: "balance", label: "Saldo" }, { value: "referrals", label: "Indicados" }, { value: "logins", label: "Acessos" }], { default: "balance" }), field.number("limit", "Quantidade", { default: 20 })] }, async (ctx, input) => {
  const { users } = await load_all();
  const counts = referral_counts(users);
  const rows = users.map((user) => user_row(user, counts)).sort((a, b) => b[input.by] - a[input.by]);
  return { rows: rows.slice(0, Math.min(100, input.limit)) };
});

define("users.tags_overview", group, "Todas as tags em uso", { roles: staff.everyone, read: true }, async () => {
  const { users } = await load_all();
  return { tags: ranked(count_by(users.flatMap((user) => user.adm?.tags || []), (tag) => tag), 100) };
});

define("users.notes", group, "Notas internas do usuário", { roles: staff.care, read: true, target: "user", fields: [email_field] }, async (ctx, input) => ({ notes: (await load_logs(["note"])).filter((log) => log.email === input.email) }));

define("users.add_note", group, "Adicionar nota interna", { roles: staff.care, target: "user", fields: [email_field, field.textarea("text", "Nota", { required: true, max: 600 })] }, async (ctx, input) => {
  await require_user(input.email);
  await log_event("note", { email: input.email, text: input.text, actor: ctx.actor.email });
  return { ok: true };
});

define("users.delete_note", group, "Apagar nota interna", { roles: staff.care, fields: [field.text("id", "ID da nota", { required: true })] }, async (ctx, input) => {
  await delete_row("logs", input.id);
  return { ok: true };
});

function define_edit(id, label, fields, build, options = {}) {
  define(id, group, label, { roles: staff.care, target: "user", fields: [email_field, ...fields], ...options }, async (ctx, input) => {
    const user = await require_user(input.email);
    const change = await build(user, input, ctx);
    const next = { ...user, ...change };
    await save_user(next);
    return { user: safe_user(next) };
  });
}

async function cascade_email(old_email, new_email) {
  const all = await load_all();
  const jobs = [
    ...all.users.filter((entry) => entry.referred_by === old_email).map((entry) => ["users", entry, { referred_by: new_email }]),
    ...all.payments.filter((entry) => entry.email === old_email).map((entry) => ["payments", entry, { email: new_email }]),
    ...all.withdrawals.filter((entry) => entry.email === old_email).map((entry) => ["withdrawals", entry, { email: new_email }]),
    ...all.commissions.filter((entry) => entry.affiliate === old_email).map((entry) => ["commissions", entry, { affiliate: new_email }]),
    ...all.commissions.filter((entry) => entry.from_user === old_email).map((entry) => ["commissions", entry, { from_user: new_email }]),
  ];
  for (const [key, row, change] of jobs) {
    const current = await get_row(key, row.msg_id);
    if (current) await patch_row(key, row.msg_id, { ...current, ...change });
  }
  return jobs.length;
}

define("users.set_email", group, "Alterar e-mail do usuário", { roles: staff.care, sudo: true, danger: true, target: "user", fields: [email_field, field.email("new_email", "Novo e-mail", { required: true }), field.checkbox("cascade", "Atualizar também indicações, pagamentos, saques e comissões", { default: true }), field.checkbox("logout", "Encerrar sessões abertas", { default: true })], description: "Troca o e-mail de login e mantém o histórico financeiro ligado à conta." }, async (ctx, input) => {
  if (input.new_email === input.email) throw new c_admin_error("O novo e-mail é igual ao atual");
  const user = await require_user(input.email);
  if (await find_user(input.new_email, { fresh: true })) throw new c_admin_error("Já existe uma conta com esse e-mail", 409);
  const next = { ...user, email: input.new_email, ...(input.logout ? adm_patch(user, { valid_after: Date.now() }) : {}) };
  await save_user(next);
  const cascaded = input.cascade ? await cascade_email(input.email, input.new_email) : 0;
  invalidate();
  return { user: safe_user(next), cascaded };
});

define("users.set_password", group, "Definir nova senha", { roles: staff.care, sudo: true, danger: true, target: "user", fields: [email_field, field.password("new_password", "Nova senha (mín. 6)", { required: true }), field.checkbox("logout", "Encerrar sessões abertas", { default: true })] }, async (ctx, input) => {
  if (input.new_password.length < 6) throw new c_admin_error("A senha precisa ter pelo menos 6 caracteres");
  const user = await require_user(input.email);
  const next = { ...user, password_hash: hash_password(input.new_password), ...(input.logout ? adm_patch(user, { valid_after: Date.now() }) : {}) };
  await save_user(next);
  return { ok: true };
});

define("users.generate_password", group, "Gerar senha temporária", { roles: staff.care, sudo: true, danger: true, target: "user", fields: [email_field] }, async (ctx, input) => {
  const user = await require_user(input.email);
  const password = random_password();
  await save_user({ ...user, password_hash: hash_password(password), ...adm_patch(user, { valid_after: Date.now() }) });
  return { password, notice: "Mostre ao usuário uma única vez. Ela não fica salva em lugar nenhum." };
});

define_edit("users.set_whatsapp", "Alterar WhatsApp", [field.text("whatsapp", "WhatsApp com DDD", { required: true })], (user, input) => {
  const whatsapp = norm_phone(input.whatsapp);
  if (!whatsapp) throw new c_admin_error("WhatsApp inválido");
  return { whatsapp };
});

define_edit("users.clear_whatsapp", "Remover WhatsApp", [], () => ({ whatsapp: null }));

define_edit("users.set_name", "Alterar nome", [field.text("name", "Nome", { required: true, max: 80 })], (user, input) => ({ name: input.name }));

define_edit("users.set_pix", "Definir chave Pix", [field.select("pix_type", "Tipo da chave", pix_type_options, { required: true }), field.text("pix_key", "Chave", { required: true }), field.text("owner_doc", "CPF/CNPJ do titular (se a chave não for CPF/CNPJ)")], (user, input) => {
  const type = PIX_TYPES[input.pix_type];
  if (!valid_pix_key(type, input.pix_key)) throw new c_admin_error("Chave Pix inválida para o tipo escolhido");
  const key = normalize_pix_key(type, input.pix_key);
  const owner_doc = type === "CPF" || type === "CNPJ" ? key : only_digits(input.owner_doc);
  if (!valid_doc(owner_doc)) throw new c_admin_error("Informe o CPF/CNPJ do titular");
  return { pix_key: key, pix_type: type, owner_doc };
}, { roles: staff.money, sudo: true });

define_edit("users.clear_pix", "Remover chave Pix", [], () => ({ pix_key: undefined, pix_type: undefined, owner_doc: undefined, auto_payout: undefined }), { roles: staff.money });

define_edit("users.set_auto_payout", "Ligar/desligar recebimento automático", [field.checkbox("enabled", "Ativado")], (user, input) => {
  if (input.enabled && !user.pix_key) throw new c_admin_error("O usuário não tem chave Pix salva");
  return { auto_payout: input.enabled || undefined };
}, { roles: staff.money });

define_edit("users.unlink_google", "Desvincular Google", [], (user) => {
  if (!user.password_hash) throw new c_admin_error("Defina uma senha antes de desvincular o Google");
  return { google: undefined };
});

define_edit("users.set_referral_code", "Definir código de indicação", [field.text("code", "Código (4-12 letras/números)", { required: true, max: 12 })], async (user, input) => {
  const code = input.code.toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new c_admin_error("Use de 4 a 12 letras ou números");
  const { users } = await load_all();
  if (users.some((entry) => entry.referral_code === code && entry.email !== user.email)) throw new c_admin_error("Código já em uso", 409);
  return { referral_code: code };
});

define_edit("users.regenerate_referral_code", "Gerar novo código de indicação", [], async (user) => {
  const { users } = await load_all();
  let code = random_code(8);
  while (users.some((entry) => entry.referral_code === code)) code = random_code(8);
  return { referral_code: code };
});

define_edit("users.set_referrer", "Definir quem indicou", [field.email("referrer", "E-mail do indicador", { required: true })], async (user, input) => {
  if (input.referrer === user.email) throw new c_admin_error("Um usuário não pode indicar a si mesmo");
  const { users } = await load_all();
  const referrer = users.find((entry) => entry.email === input.referrer);
  if (!referrer) throw new c_admin_error("Indicador não encontrado", 404);
  const seen = new Set([user.email]);
  let cursor = referrer;
  while (cursor?.referred_by) {
    if (seen.has(cursor.referred_by)) throw new c_admin_error("Isso criaria um ciclo de indicações");
    seen.add(cursor.referred_by);
    cursor = users.find((entry) => entry.email === cursor.referred_by);
  }
  return { referred_by: referrer.email };
}, { roles: staff.admin, sudo: true });

define_edit("users.clear_referrer", "Remover indicador", [], () => ({ referred_by: null }), { roles: staff.admin, sudo: true });

define_edit("users.revoke_plan", "Remover plano", [reason_field], async (user, input, ctx) => {
  await log_event("plan_change", { email: user.email, from: user.plan || null, to: null, reason: input.reason, actor: ctx.actor.email });
  return { plan: null, plan_activated_at: null };
}, { roles: staff.money, sudo: true, danger: true });

define("users.grant_plan", group, "Ativar plano manualmente", { roles: staff.money, sudo: true, target: "user", fields: [email_field, field.select("plan_price", "Plano", plan_options, { required: true }), field.checkbox("pay_commission", "Pagar comissão ao indicador"), field.checkbox("count_revenue", "Registrar como pagamento recebido"), reason_field] }, async (ctx, input) => {
  const price = Number(input.plan_price);
  const user = await require_user(input.email);
  if (input.count_revenue) await post_row("payments", { email: user.email, plan_price: price, payment_id: `manual-${Date.now()}`, status: "approved", source: "admin", granted_by: ctx.actor.email, created_at: new Date().toISOString(), paid_at: new Date().toISOString() });
  if (input.pay_commission) await activate_user_plan(user.email, price);
  else await save_user({ ...user, plan: price, plan_activated_at: new Date().toISOString() });
  await log_event("plan_change", { email: user.email, from: user.plan || null, to: price, reason: input.reason, actor: ctx.actor.email });
  invalidate();
  return { ok: true };
});

define("users.adjust_balance", group, "Ajustar saldo", { roles: staff.money, sudo: true, danger: true, target: "user", fields: [email_field, field.select("mode", "Operação", [{ value: "add", label: "Creditar" }, { value: "subtract", label: "Debitar" }, { value: "set", label: "Definir valor exato" }], { required: true }), field.number("amount", "Valor (R$)", { required: true }), field.checkbox("allow_negative", "Permitir saldo negativo"), reason_field] }, async (ctx, input) => {
  if (input.amount < 0) throw new c_admin_error("Use um valor positivo");
  const user = await require_user(input.email);
  const before = money(user.balance);
  const after = money(input.mode === "add" ? before + input.amount : input.mode === "subtract" ? before - input.amount : input.amount);
  if (after < 0 && !input.allow_negative) throw new c_admin_error("O saldo ficaria negativo");
  await save_user({ ...user, balance: after });
  await log_event("ledger", { email: user.email, delta: money(after - before), before, after, reason: input.reason, actor: ctx.actor.email });
  return { before, after };
});

define_edit("users.ban", "Banir usuário", [reason_field, field.checkbox("logout", "Encerrar sessões", { default: true })], (user, input, ctx) => {
  if (user.adm?.role || user.email === ctx.actor.email) throw new c_admin_error("Não é possível banir um membro da equipe ou a si mesmo");
  return adm_patch(user, { banned: true, ban_reason: input.reason, banned_at: new Date().toISOString(), banned_by: ctx.actor.email, suspended_until: undefined, valid_after: input.logout ? Date.now() : user.adm?.valid_after });
}, { danger: true });

define_edit("users.unban", "Desbanir / reativar usuário", [], (user) => adm_patch(user, { banned: undefined, ban_reason: undefined, banned_at: undefined, banned_by: undefined, suspended_until: undefined }));

define_edit("users.suspend", "Suspender temporariamente", [field.datetime("until", "Suspenso até", { required: true }), reason_field], (user, input, ctx) => {
  if (user.adm?.role || user.email === ctx.actor.email) throw new c_admin_error("Não é possível suspender um membro da equipe ou a si mesmo");
  return adm_patch(user, { suspended_until: input.until, ban_reason: input.reason, valid_after: Date.now() });
}, { danger: true });

define_edit("users.block_withdrawals", "Bloquear saques", [reason_field], (user) => adm_patch(user, { withdraw_blocked: true }), { roles: staff.money });
define_edit("users.unblock_withdrawals", "Liberar saques", [], (user) => adm_patch(user, { withdraw_blocked: undefined }), { roles: staff.money });
define_edit("users.force_logout", "Encerrar todas as sessões", [], (user) => adm_patch(user, { valid_after: Date.now() }));

define_edit("users.add_tag", "Adicionar tag", [field.text("tag", "Tag (a-z, 0-9, _ -)", { required: true, max: 16 })], (user, input) => {
  const tag = input.tag.toLowerCase();
  if (!/^[a-z0-9_-]{1,16}$/.test(tag)) throw new c_admin_error("Tag inválida");
  const tags = [...new Set([...(user.adm?.tags || []), tag])];
  if (tags.length > 8) throw new c_admin_error("Máximo de 8 tags por usuário");
  return adm_patch(user, { tags });
});

define_edit("users.remove_tag", "Remover tag", [field.text("tag", "Tag", { required: true, max: 16 })], (user, input) => adm_patch(user, { tags: (user.adm?.tags || []).filter((tag) => tag !== input.tag.toLowerCase()) }));

define_edit("users.set_role", "Definir cargo da equipe", [field.select("role", "Cargo", [{ value: "", label: "Nenhum (usuário comum)" }, { value: "support", label: "Suporte" }, { value: "finance", label: "Financeiro" }, { value: "admin", label: "Administrador" }])], (user, input) => adm_patch(user, { role: input.role || undefined, valid_after: Date.now() }), { roles: staff.owner, sudo: true, danger: true });

define("users.impersonate", group, "Entrar como o usuário (suporte)", { roles: staff.admin, sudo: true, danger: true, target: "user", fields: [email_field, reason_field], description: "Abre a conta do usuário por 1 hora. Fica registrado no log de auditoria." }, async (ctx, input) => {
  const user = await require_user(input.email);
  if (user.adm?.role) throw new c_admin_error("Não é possível entrar como um membro da equipe");
  return { token: make_token(user.email, 1 / 24), email: user.email };
});

define("users.delete", group, "Excluir usuário definitivamente", { roles: staff.admin, sudo: true, danger: true, target: "user", fields: [email_field, field.email("confirm", "Digite o e-mail novamente para confirmar", { required: true }), reason_field] }, async (ctx, input) => {
  if (input.confirm !== input.email) throw new c_admin_error("A confirmação não confere");
  const user = await require_user(input.email);
  if (user.adm?.role || user.email === ctx.actor.email) throw new c_admin_error("Não é possível excluir um membro da equipe ou a si mesmo");
  const { password_hash, msg_id, msg_at, ...snapshot } = user;
  await log_event("user_deleted", { email: user.email, reason: input.reason, actor: ctx.actor.email, snapshot: JSON.stringify(snapshot).slice(0, 1200) });
  await delete_row("users", msg_id);
  return { ok: true };
});

const bulk_ops = {
  ban: (user, value, ctx) => adm_patch(user, { banned: true, ban_reason: value || "ação em massa", banned_at: new Date().toISOString(), banned_by: ctx.actor.email, valid_after: Date.now() }),
  unban: (user) => adm_patch(user, { banned: undefined, ban_reason: undefined, banned_at: undefined, banned_by: undefined, suspended_until: undefined }),
  add_tag: (user, value) => adm_patch(user, { tags: [...new Set([...(user.adm?.tags || []), String(value).toLowerCase().slice(0, 16)])].slice(0, 8) }),
  remove_tag: (user, value) => adm_patch(user, { tags: (user.adm?.tags || []).filter((tag) => tag !== String(value).toLowerCase()) }),
  block_withdrawals: (user) => adm_patch(user, { withdraw_blocked: true }),
  unblock_withdrawals: (user) => adm_patch(user, { withdraw_blocked: undefined }),
  force_logout: (user) => adm_patch(user, { valid_after: Date.now() }),
};

define("users.bulk", group, "Ação em massa (até 100 usuários)", { roles: staff.admin, sudo: true, danger: true, fields: [field.list("emails", "E-mails (um por linha ou separados por vírgula)", { required: true }), field.select("op", "Ação", [{ value: "ban", label: "Banir" }, { value: "unban", label: "Desbanir" }, { value: "add_tag", label: "Adicionar tag" }, { value: "remove_tag", label: "Remover tag" }, { value: "block_withdrawals", label: "Bloquear saques" }, { value: "unblock_withdrawals", label: "Liberar saques" }, { value: "force_logout", label: "Encerrar sessões" }], { required: true }), field.text("value", "Tag / motivo (quando aplicável)")] }, async (ctx, input) => {
  const emails = [...new Set(input.emails.map((email) => email.toLowerCase()))].slice(0, 100);
  const done = [];
  const failed = [];
  for (const email of emails) {
    try {
      const user = await require_user(email);
      if (user.adm?.role && ["ban"].includes(input.op)) throw new c_admin_error("equipe protegida");
      await save_user({ ...user, ...bulk_ops[input.op](user, input.value, ctx) });
      done.push(email);
    } catch (error) {
      failed.push({ email, error: error.message });
    }
  }
  return { done: done.length, failed };
});

define("users.staff", group, "Membros da equipe", { roles: staff.admin, read: true }, async () => {
  const { users } = await load_all();
  return { rows: users.filter((user) => user.adm?.role).map((user) => user_row(user)) };
});
