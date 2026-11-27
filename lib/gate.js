import { get_settings, get_blocklist, read_channel } from "./store.js";

export function account_state(user, now = Date.now()) {
  const adm = user.adm || {};
  if (adm.banned) return "banned";
  if (adm.suspended_until && Date.parse(adm.suspended_until) > now) return "suspended";
  return "active";
}

export function blocked_message(user) {
  const state = account_state(user);
  if (state === "banned") return "Conta bloqueada. Fale com o suporte.";
  if (state === "suspended") return "Conta temporariamente suspensa. Fale com o suporte.";
  return null;
}

export async function blocklist_reason(context, email) {
  const list = await get_blocklist();
  const domain = String(email || "").split("@")[1];
  if (context.ip && list.ips.includes(context.ip)) return "Acesso não permitido a partir desta rede.";
  if (context.client.fp && list.fps.includes(context.client.fp)) return "Acesso não permitido a partir deste dispositivo.";
  if (email && list.emails.includes(email)) return "Este e-mail não pode ser utilizado.";
  if (domain && list.domains.includes(domain)) return "Este provedor de e-mail não é aceito.";
  return null;
}

export async function check_signup(context, email) {
  const settings = await get_settings();
  if (settings.maintenance) return settings.maintenance_message || "Site em manutenção. Volte em instantes.";
  if (!settings.signups_open) return "Novos cadastros estão temporariamente fechados.";
  const reason = await blocklist_reason(context, email);
  if (reason) return reason;
  if (!(settings.max_accounts_per_ip > 0) || !context.ip) return null;
  const users = await read_channel("users");
  const same_network = users.filter((user) => user.reg?.ip === context.ip).length;
  return same_network >= settings.max_accounts_per_ip ? "Limite de cadastros atingido para esta rede." : null;
}

export const check_login = (context, email) => blocklist_reason(context, email);
