// DNS 解析服务商映射表（前后端共享语义）
//
// 架构约定（2026-08-25 用户确认）：
// - 除 "local" 外，所有 DoH 解析都【由浏览器客户端直接发起】（包括自定义、
//   内网自签）。原因：Cloudflare Worker 的 fetch 只能访问公网且必须受信 CA 证书，
//   无法连内网 / 自签 DoH；而浏览器可手动信任自签证书、可访问同局域网地址。
// - "local" 由 Worker 自己发起解析（服务端视角），代表「服务端 -> 域名」的解析结果。
// - 公开 DoH（aliyun/tencent/...）的 doh 字段供浏览器侧直接使用。
// - "custom" = 用户提供的公开 https DoH；"browser" = 用户提供的【内网自签 https DoH】，
//   二者均为浏览器直连，区别仅在校验文案（自签需先在浏览器手动信任）。

// 用数组固定下拉顺序（对象在含数字键 "360" 时枚举顺序会乱）
export const DNS_PROVIDER_LIST = [
  { key: "local", label: "本地（服务端 DNS）", doh: "", note: "服务端运行环境默认递归解析" },
  { key: "aliyun", label: "阿里 DoH", doh: "https://dns.alidns.com/dns-query" },
  { key: "tencent", label: "腾讯 DoH", doh: "https://doh.pub/dns-query" },
  { key: "qihoo360", label: "360 DoH", doh: "https://doh.360.cn/dns-query" },
  { key: "google", label: "Google DoH", doh: "https://dns.google/dns-query" },
  { key: "cloudflare", label: "Cloudflare DoH", doh: "https://1.1.1.1/dns-query" },
  { key: "opendns", label: "OpenDNS DoH", doh: "https://doh.opendns.com/dns-query" },
  { key: "custom", label: "自定义 DoH（浏览器直连·公开）", doh: "", custom: true },
  { key: "browser", label: "内网自签 DoH（浏览器直连）", doh: "", browser: true, custom: true },
];

export const DNS_PROVIDERS = Object.fromEntries(
  DNS_PROVIDER_LIST.map((p) => [p.key, p])
);

// 仅用于 "local"（服务端解析）：返回服务端使用的 DoH 列表。
// 其他 provider 均由浏览器客户端直连，不再经过本函数（见 page.js 的浏览器解析分支）。
export function resolveDohList(provider, customDoh) {
  if (provider === "local") {
    // 服务端 Worker 自行发起（边缘递归解析器，代表服务端视角）
    return ["https://1.1.1.1/dns-query"];
  }
  const list = [];
  if (provider === "custom" || provider === "browser") {
    if (customDoh && /^https:\/\//i.test(customDoh.trim())) list.push(customDoh.trim());
  } else if (provider && DNS_PROVIDERS[provider] && DNS_PROVIDERS[provider].doh) {
    list.push(DNS_PROVIDERS[provider].doh);
  }
  return list; // 非空表示浏览器直连模式（前端不调用此函数解析）
}

// 供前端（浏览器）使用的 DoH URL 查询：返回某 provider 对应的浏览器直连 DoH 地址。
// - local 返回 null（由服务端解析，前端不应调用）
// - custom/browser 返回用户填写的自定义地址
// - 其余返回该服务商的公开 DoH 地址
export function getDohUrl(provider, customDoh) {
  if (provider === "local") return null;
  if (provider === "custom" || provider === "browser") return (customDoh || "").trim();
  return (DNS_PROVIDERS[provider] && DNS_PROVIDERS[provider].doh) || null;
}

// 兼容旧 localStorage 中可能存的 "360" key，自动映射为新 key
export function normalizeProviderKey(key) {
  if (key === "360") return "qihoo360";
  return DNS_PROVIDERS[key] ? key : "local";
}
