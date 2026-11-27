import "../lib/admin/users.js";
import "../lib/admin/finance.js";
import "../lib/admin/analytics.js";
import "../lib/admin/security.js";
import "../lib/admin/system.js";
import { registry, catalog_for, parse_input, c_admin_error } from "../lib/admin/registry.js";
import { read_token, verify_password, ADMIN_EMAIL, MpError } from "../lib/mercadopago.js";
import { find_user, log_event } from "../lib/store.js";
import { request_context, log_context } from "../lib/telemetry.js";
import { account_state } from "../lib/gate.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

const roles = new Set(["admin", "support", "finance"]);
const sudo_failures = new Map();
const masked_types = new Set(["password"]);

function role_of(user) {
  if (user.email === ADMIN_EMAIL) return "owner";
  return roles.has(user.adm?.role) ? user.adm.role : null;
}

function check_sudo(actor, password) {
  const entry = sudo_failures.get(actor.email) || { count: 0, until: 0 };
  if (entry.until > Date.now()) throw new c_admin_error("Muitas tentativas. Aguarde alguns minutos.", 429, "sudo");
  if (!actor.password_hash) throw new c_admin_error("Defina uma senha na conta do administrador para confirmar ações sensíveis.", 400, "sudo");
  if (password && verify_password(String(password), actor.password_hash)) return sudo_failures.delete(actor.email);
  const count = entry.count + 1;
  sudo_failures.set(actor.email, count >= 5 ? { count: 0, until: Date.now() + 15 * 60000 } : { count, until: 0 });
  throw new c_admin_error("Confirme sua senha de administrador", 403, "sudo");
}

function summarize(spec, input) {
  const hidden = new Set(spec.fields.filter((item) => masked_types.has(item.type)).map((item) => item.name));
  const clean = Object.fromEntries(Object.entries(input).map(([name, value]) => [name, hidden.has(name) ? "***" : value]));
  return JSON.stringify(clean).slice(0, 700);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "método não permitido" });

  const { action, token, sudo_password, ...raw } = req.body || {};
  const session = read_token(token);
  if (!session) return res.status(401).json({ error: "Sessão expirada. Entre novamente.", code: "auth" });

  const actor = await find_user(session.email);
  const role = actor ? role_of(actor) : null;
  const context = request_context(req);
  if (!actor || !role || account_state(actor) !== "active" || (actor.adm?.valid_after && session.issued_at < actor.adm.valid_after)) {
    await log_event("audit_denied", { actor: session.email, action: String(action).slice(0, 60), reason: "sem permissão de administrador", ...log_context(context) });
    return res.status(403).json({ error: "Acesso negado" });
  }

  if (action === "catalog") return res.status(200).json({ role, email: actor.email, actions: catalog_for(role), staff_roles: ["support", "finance", "admin"] });

  const spec = registry.get(action);
  if (!spec) return res.status(404).json({ error: "Função desconhecida" });
  if (role !== "owner" && !spec.roles.includes(role)) {
    await log_event("audit_denied", { actor: actor.email, role, action: spec.id, reason: "cargo insuficiente", ...log_context(context) });
    return res.status(403).json({ error: "Seu cargo não permite esta função" });
  }

  try {
    const input = parse_input(spec, raw);
    if (spec.sudo) check_sudo(actor, sudo_password);
    const result = await spec.run({ actor, role, context, session }, input);
    if (!spec.read) await log_event("audit", { actor: actor.email, role, action: spec.id, target: input.email || input.id || input.payment_id || input.ip || null, input: summarize(spec, input), ip: context.ip, cc: context.cc });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof c_admin_error) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof MpError) return res.status(502).json({ error: `Mercado Pago: ${error.message}` });
    console.error("[admin]", spec.id, error);
    return res.status(500).json({ error: error.message || "Erro interno" });
  }
}
