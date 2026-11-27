const discord_api = "https://discord.com/api/v10";
const bot_token = process.env.DISCORD_BOT_TOKEN;
const request_headers = { Authorization: `Bot ${bot_token}`, "Content-Type": "application/json" };
const content_limit = 2000;
const cache_ttl = 12000;
const snowflake_epoch = 1420070400000n;
const page_limits = { users: 500, payments: 500, withdrawals: 500, commissions: 500, logs: 40, config: 20, support: 100 };
const protected_keys = new Set(["password_hash", "email", "pix_key", "owner_doc", "referral_code", "referred_by", "type"]);
const cache = new Map();

export const channels = {
  users: process.env.DISCORD_CHANNEL_USUARIOS,
  payments: process.env.DISCORD_CHANNEL_PAGAMENTOS,
  withdrawals: process.env.DISCORD_CHANNEL_SAQUES,
  commissions: process.env.DISCORD_CHANNEL_COMISSOES,
  logs: process.env.DISCORD_CHANNEL_LOGS,
  config: process.env.DISCORD_CHANNEL_CONFIG,
  support: process.env.DISCORD_CHANNEL_SUPORTE,
};

export const default_settings = {
  signups_open: true,
  withdrawals_open: true,
  maintenance: false,
  maintenance_message: "",
  min_withdraw: 1,
  max_withdraw: 0,
  max_accounts_per_ip: 0,
  support_whatsapp: "",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const strip_meta = ({ msg_id, msg_at, ...data }) => data;

export const snowflake_time = (id) => Number((BigInt(id) >> 22n) + snowflake_epoch);
export const channel_ready = (key) => !!channels[key];
export const invalidate = (key) => key ? cache.delete(key) : cache.clear();

export async function discord_call(method, path, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${discord_api}${path}`, { method, headers: request_headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 204) return { ok: true };
    if (response.status !== 429) return response.json().catch(() => ({ message: `http_${response.status}` }));
    const limited = await response.json().catch(() => ({}));
    await sleep(Math.min(5000, Math.ceil((limited.retry_after || 1) * 1000)));
  }
  return { message: "rate_limited" };
}

const parse_message = (message) => {
  try {
    const data = JSON.parse(message.content);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return { ...data, msg_id: message.id, msg_at: snowflake_time(message.id) };
  } catch {
    return null;
  }
};

const shrink_strings = (data, limit) => Object.fromEntries(Object.entries(data).map(([name, value]) => [name, typeof value === "string" && value.length > limit && !protected_keys.has(name) ? value.slice(0, limit) : value]));

const reducers = [
  (data) => data.reg ? { ...data, reg: { ...data.reg, ua: undefined } } : data,
  (data) => data.last ? { ...data, last: { ...data.last, ua: undefined } } : data,
  (data) => shrink_strings(data, 400),
  (data) => shrink_strings(data, 160),
  (data) => shrink_strings(data, 60),
  (data) => data.last ? { ...data, last: undefined } : data,
];

export function fit_content(data) {
  let current = strip_meta(data);
  let content = JSON.stringify(current);
  for (const reduce of reducers) {
    if (content.length <= content_limit) return content;
    current = reduce(current);
    content = JSON.stringify(current);
  }
  if (content.length > content_limit) throw new Error("O registro excede o limite de 2000 caracteres do Discord");
  return content;
}

export async function read_channel(key, { fresh = false } = {}) {
  const channel_id = channels[key];
  if (!channel_id) return [];
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < cache_ttl) return hit.rows;

  const rows = [];
  let before = null;
  for (let page = 0; page < (page_limits[key] || 100); page++) {
    const batch = await discord_call("GET", `/channels/${channel_id}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const message of batch) {
      const row = parse_message(message);
      if (row) rows.push(row);
    }
    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function channel_probe(key) {
  if (!channels[key]) return { configured: false, ok: false };
  const batch = await discord_call("GET", `/channels/${channels[key]}/messages?limit=1`);
  return { configured: true, ok: Array.isArray(batch), error: Array.isArray(batch) ? null : batch?.message || "erro desconhecido" };
}

export async function get_row(key, msg_id) {
  const message = await discord_call("GET", `/channels/${channels[key]}/messages/${msg_id}`);
  return message?.id ? parse_message(message) : null;
}

export async function post_row(key, data) {
  if (!channels[key]) throw new Error(`Canal "${key}" não configurado`);
  const message = await discord_call("POST", `/channels/${channels[key]}/messages`, { content: fit_content(data) });
  invalidate(key);
  if (!message?.id) throw new Error(message?.message || "Falha ao gravar no Discord");
  return parse_message(message);
}

export async function patch_row(key, msg_id, data) {
  const message = await discord_call("PATCH", `/channels/${channels[key]}/messages/${msg_id}`, { content: fit_content(data) });
  invalidate(key);
  if (!message?.id) throw new Error(message?.message || "Falha ao gravar no Discord");
  return parse_message(message);
}

export async function delete_row(key, msg_id) {
  const result = await discord_call("DELETE", `/channels/${channels[key]}/messages/${msg_id}`);
  invalidate(key);
  if (result?.code) throw new Error(result.message || "Falha ao excluir no Discord");
  return true;
}

export async function find_user(email, { fresh = false } = {}) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) return null;
  let rows = await read_channel("users", { fresh });
  let row = rows.find((user) => user.email === target);
  if (!row && !fresh) {
    rows = await read_channel("users", { fresh: true });
    row = rows.find((user) => user.email === target);
  }
  if (!row) return null;
  const current = await get_row("users", row.msg_id);
  return current && current.email === target ? current : null;
}

export const save_user = (user) => patch_row("users", user.msg_id, user);

export async function log_event(type, data = {}) {
  if (!channels.logs) return null;
  try {
    return await post_row("logs", { type, at: new Date().toISOString(), ts: Date.now(), ...data });
  } catch (error) {
    console.error("[log_event]", type, error.message);
    return null;
  }
}

export const read_logs = async (filter) => {
  const rows = await read_channel("logs");
  return filter ? rows.filter(filter) : rows;
};

export async function get_config(type) {
  const rows = await read_channel("config");
  return rows.find((row) => row.type === type) || null;
}

export const list_config = async (type) => (await read_channel("config")).filter((row) => row.type === type);

export async function set_config(type, data) {
  const existing = await get_config(type);
  const payload = { ...data, type };
  return existing ? patch_row("config", existing.msg_id, payload) : post_row("config", payload);
}

export async function get_settings() {
  const row = await get_config("settings");
  const stored = Object.fromEntries(Object.keys(default_settings).filter((name) => row && row[name] !== undefined).map((name) => [name, row[name]]));
  return { ...default_settings, ...stored };
}

export async function get_blocklist() {
  const row = await get_config("blocklist");
  return { ips: row?.ips || [], emails: row?.emails || [], domains: row?.domains || [], fps: row?.fps || [] };
}
