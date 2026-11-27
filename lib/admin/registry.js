export class c_admin_error extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const registry = new Map();

export const staff = {
  everyone: ["admin", "support", "finance"],
  admin: ["admin"],
  care: ["admin", "support"],
  money: ["admin", "finance"],
  owner: [],
};

const field_of = (type) => (name, label, extra = {}) => ({ type, name, label, ...extra });

export const field = {
  text: field_of("text"),
  textarea: field_of("textarea"),
  email: field_of("email"),
  password: field_of("password"),
  number: field_of("number"),
  checkbox: field_of("checkbox"),
  date: field_of("date"),
  datetime: field_of("datetime"),
  list: field_of("list"),
  select: (name, label, options, extra = {}) => ({ type: "select", name, label, options, ...extra }),
};

export const email_field = field.email("email", "E-mail do usuário", { required: true });
export const reason_field = field.text("reason", "Motivo", { required: true, max: 200 });

export function define(id, group, label, options, run) {
  registry.set(id, { id, group, label, roles: staff.admin, fields: [], read: false, sudo: false, danger: false, target: null, description: "", ...options, run });
}

const coerce = {
  text: (value) => String(value ?? "").trim(),
  textarea: (value) => String(value ?? "").trim(),
  email: (value) => String(value ?? "").trim().toLowerCase(),
  password: (value) => String(value ?? ""),
  select: (value) => String(value ?? ""),
  number: (value) => Number(value),
  checkbox: (value) => value === true || value === "true" || value === 1 || value === "1" || value === "on",
  date: (value) => String(value ?? "").trim(),
  datetime: (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  },
  list: (value) => (Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[\s,;]+/)).map((item) => item.trim()).filter(Boolean),
};

const empty = (value) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export function parse_input(spec, raw) {
  const input = {};
  for (const item of spec.fields) {
    const given = raw[item.name];
    if (empty(given) && item.type !== "checkbox") {
      if (item.required) throw new c_admin_error(`Campo obrigatório: ${item.label}`);
      if (item.default !== undefined) input[item.name] = item.default;
      continue;
    }
    const value = coerce[item.type](given);
    if (item.type === "number" && Number.isNaN(value)) throw new c_admin_error(`Número inválido: ${item.label}`);
    if (item.type === "datetime" && value === null) throw new c_admin_error(`Data inválida: ${item.label}`);
    if (item.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new c_admin_error(`E-mail inválido: ${item.label}`);
    if (item.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new c_admin_error(`Data inválida: ${item.label}`);
    if (item.type === "select" && !item.options.some((option) => String(option.value ?? option) === value)) throw new c_admin_error(`Opção inválida: ${item.label}`);
    if (typeof value === "string" && value.length > (item.max || 2000)) throw new c_admin_error(`Texto longo demais: ${item.label}`);
    input[item.name] = value;
  }
  return input;
}

export function catalog_for(role) {
  return [...registry.values()]
    .filter((spec) => role === "owner" || spec.roles.includes(role))
    .map(({ run, ...spec }) => spec);
}
