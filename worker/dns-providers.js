// DNS 解析服务商映射表（前后端共享语义）
// Worker 侧通过 provider key 选择对应的 DoH 地址；
// 前端下拉使用 LABEL 展示，VALUE 作为请求参数。
//
// 说明：
// - "local" 指「服务端本地 DNS」：Worker 运行环境用其默认递归解析，
//   并非用户电脑的 DNS（浏览器无法访问用户设备 DNS）。前端会标注说明。
// - "custom" 为自定义 DoH（HTTPS）地址，仅接受 https:// 开头的 DoH URL，
//   不支持裸 UDP 53（Worker/Browser 的 fetch 无法发 UDP 包）。

// 用数组固定下拉顺序（对象在含数字键 "360" 时枚举顺序会乱）
export const DNS_PROVIDER_LIST = [
  { key: "local", label: "本地（服务端 DNS）", doh: "", note: "服务端运行环境默认递归解析" },
  { key: "aliyun", label: "阿里 DoH", doh: "https://dns.alidns.com/dns-query" },
  { key: "tencent", label: "腾讯 DoH", doh: "https://doh.pub/dns-query" },
  { key: "qihoo360", label: "360 DoH", doh: "https://doh.360.cn/dns-query" },
  { key: "google", label: "Google DoH", doh: "https://dns.google/dns-query" },
  { key: "cloudflare", label: "Cloudflare DoH", doh: "https://1.1.1.1/dns-query" },
  { key: "opendns", label: "OpenDNS DoH", doh: "https://doh.opendns.com/dns-query" },
  { key: "custom", label: "自定义 DoH", doh: "", custom: true },
];

export const DNS_PROVIDERS = Object.fromEntries(
  DNS_PROVIDER_LIST.map((p) => [p.key, p])
);

// 按顺序返回候选 DoH 列表：优先用户所选，失败回退阿里+腾讯兜底
export function resolveDohList(provider, customDoh) {
  const list = [];
  if (provider === "custom") {
    if (customDoh && /^https:\/\//i.test(customDoh.trim())) {
      list.push(customDoh.trim());
    }
  } else if (provider && DNS_PROVIDERS[provider] && DNS_PROVIDERS[provider].doh) {
    list.push(DNS_PROVIDERS[provider].doh);
  }
  // 兜底：阿里 + 腾讯（避免单点 DoH 失败导致全量解析失败）
  if (list.length === 0 || provider === "local") {
    list.push("https://dns.alidns.com/dns-query");
    list.push("https://doh.pub/dns-query");
  }
  return list;
}

// 兼容旧 localStorage 中可能存的 "360" key，自动映射为新 key
export function normalizeProviderKey(key) {
  if (key === "360") return "qihoo360";
  return DNS_PROVIDERS[key] ? key : "local";
}
