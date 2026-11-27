const browsers = [
  [/edg(?:e|a|ios)?\/([\d.]+)/i, "Edge"],
  [/(?:opr|opera)\/([\d.]+)/i, "Opera"],
  [/samsungbrowser\/([\d.]+)/i, "Samsung"],
  [/(?:chrome|crios)\/([\d.]+)/i, "Chrome"],
  [/(?:firefox|fxios)\/([\d.]+)/i, "Firefox"],
  [/version\/([\d.]+).*safari/i, "Safari"],
];

const systems = [
  [/windows nt 10/i, "Windows 10/11"],
  [/windows nt 6\.3/i, "Windows 8.1"],
  [/windows nt 6\.1/i, "Windows 7"],
  [/windows/i, "Windows"],
  [/android ([\d.]+)/i, "Android"],
  [/(?:iphone|ipad|ipod).*os ([\d_]+)/i, "iOS"],
  [/mac os x/i, "macOS"],
  [/cros/i, "ChromeOS"],
  [/linux/i, "Linux"],
];

const header_value = (req, name) => {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value || null;
};

const decode = (value) => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const short = (value, limit) => value === undefined || value === null ? undefined : String(value).slice(0, limit);

const host_of = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

export const compact = (data) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null && value !== undefined && value !== ""));

export function client_ip(req) {
  const forwarded = header_value(req, "x-forwarded-for");
  const first = forwarded ? forwarded.split(",")[0].trim() : null;
  return first || header_value(req, "x-real-ip") || req.socket?.remoteAddress || null;
}

export function parse_user_agent(ua) {
  const text = String(ua || "");
  const browser_match = browsers.map(([pattern, name]) => ({ match: text.match(pattern), name })).find((entry) => entry.match);
  const system_match = systems.map(([pattern, name]) => ({ match: text.match(pattern), name })).find((entry) => entry.match);
  const is_tablet = /ipad|tablet/i.test(text) || (/android/i.test(text) && !/mobile/i.test(text));
  const is_mobile = /mobile|iphone|ipod|android/i.test(text);
  const device = /bot|crawler|spider|curl|wget|python|node-fetch/i.test(text) ? "bot" : is_tablet ? "tablet" : is_mobile ? "mobile" : "desktop";
  const browser_version = browser_match?.match?.[1] ? browser_match.match[1].split(".")[0] : "";
  const system_version = system_match?.match?.[1] ? ` ${system_match.match[1].replace(/_/g, ".")}` : "";
  return {
    browser: browser_match ? `${browser_match.name} ${browser_version}`.trim() : "Desconhecido",
    os: system_match ? `${system_match.name}${system_version}` : "Desconhecido",
    device,
  };
}

export function request_context(req, client = {}) {
  const ua = header_value(req, "user-agent") || "";
  const parsed = parse_user_agent(ua);
  const referrer = header_value(req, "referer");
  const info = client && typeof client === "object" ? client : {};
  return {
    ip: client_ip(req),
    cc: header_value(req, "x-vercel-ip-country"),
    rg: header_value(req, "x-vercel-ip-country-region"),
    ct: decode(header_value(req, "x-vercel-ip-city")),
    lat: header_value(req, "x-vercel-ip-latitude"),
    lon: header_value(req, "x-vercel-ip-longitude"),
    ip_tz: header_value(req, "x-vercel-ip-timezone"),
    ua,
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    lang: short((header_value(req, "accept-language") || "").split(",")[0], 12),
    referrer,
    ref_host: host_of(info.referrer || referrer),
    vercel_id: header_value(req, "x-vercel-id"),
    client: {
      tz: short(info.tz, 40),
      scr: short(info.scr, 20),
      dpr: short(info.dpr, 6),
      plat: short(info.plat, 30),
      cores: short(info.cores, 4),
      mem: short(info.mem, 4),
      touch: short(info.touch, 3),
      fp: short(info.fp, 20),
      lang: short(info.lang, 12),
      utm_source: short(info.utm_source, 40),
      utm_medium: short(info.utm_medium, 40),
      utm_campaign: short(info.utm_campaign, 60),
      landing: short(info.landing, 160),
    },
  };
}

export const compact_context = (context, at = new Date().toISOString()) => compact({
  at,
  ip: context.ip,
  cc: context.cc,
  rg: context.rg,
  ct: context.ct,
  br: context.browser,
  os: context.os,
  dv: context.device,
  tz: context.client.tz,
  ln: context.lang,
  sc: context.client.scr,
  fp: context.client.fp,
  rf: context.ref_host,
  ut: context.client.utm_source,
  ua: short(context.ua, 90),
});

export const log_context = (context) => compact({
  ip: context.ip,
  cc: context.cc,
  rg: context.rg,
  ct: context.ct,
  lat: context.lat,
  lon: context.lon,
  ip_tz: context.ip_tz,
  browser: context.browser,
  os: context.os,
  device: context.device,
  lang: context.lang,
  tz: context.client.tz,
  scr: context.client.scr,
  dpr: context.client.dpr,
  plat: context.client.plat,
  cores: context.client.cores,
  mem: context.client.mem,
  touch: context.client.touch,
  fp: context.client.fp,
  ref: context.ref_host,
  utm_source: context.client.utm_source,
  utm_medium: context.client.utm_medium,
  utm_campaign: context.client.utm_campaign,
  landing: context.client.landing,
  ua: short(context.ua, 180),
});
