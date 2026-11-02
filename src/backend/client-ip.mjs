import { BlockList, isIP } from "node:net";

export const DEFAULT_TRUSTED_PROXIES = ["loopback"];

/*
 * Build a matcher for trusted reverse proxies.
 *
 * Entries are IP addresses, CIDR ranges (10.0.0.0/8, fd00::/8)
 * or the keyword "loopback" (127.0.0.0/8 and ::1). Accepts an
 * array or a comma-separated string (BRAINSTEM_TRUSTED_PROXIES).
 * An empty list trusts no proxy.
 */
export function createTrustedProxies(value = DEFAULT_TRUSTED_PROXIES) {
  const entries = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map(entry => String(entry).trim())
    .filter(Boolean);
  const list = new BlockList();

  for (const entry of entries) {
    if (entry === "loopback") {
      list.addSubnet("127.0.0.0", 8, "ipv4");
      list.addAddress("::1", "ipv6");
      continue;
    }

    const [address, prefix] = entry.split("/");
    const family = isIP(address);
    if (!family) throw new Error(`Invalid trusted proxy '${entry}'`);
    const type = family === 6 ? "ipv6" : "ipv4";

    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }

  return {
    entries,
    has(address) {
      const normalized = normalizeIp(address);
      const family = isIP(normalized);
      if (!family) return false;
      return list.check(normalized, family === 6 ? "ipv6" : "ipv4");
    }
  };
}

/*
 * Client address for rate limiting. X-Forwarded-For is only
 * honoured when the socket peer is a trusted proxy; then the
 * right-most hop that is not itself a trusted proxy wins.
 */
export function clientIp(request, trustedProxies) {
  const peer = normalizeIp(request.socket?.remoteAddress) || "unknown";
  if (!trustedProxies?.has(peer)) return peer;

  const header = request.headers?.["x-forwarded-for"];
  const hops = (Array.isArray(header) ? header.join(",") : String(header ?? ""))
    .split(",")
    .map(hop => normalizeIp(hop.trim()))
    .filter(hop => isIP(hop));

  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!trustedProxies.has(hops[index])) return hops[index];
  }

  return hops[0] ?? peer;
}

export function normalizeIp(address) {
  const value = String(address ?? "").trim();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : value;
}
