"use strict";

/**
 * Network helpers: find the LAN addresses phones can use to reach this server.
 */

const os = require("node:os");

/** Rank of an IPv4 address: typical home/office ranges first, link-local excluded. */
function rank(address) {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/**
 * Non-internal IPv4 addresses, best candidates first. Link-local addresses
 * (169.254.x.x, assigned when DHCP fails) are never reachable from phones.
 *
 * @returns {{ address: string, interface: string }[]}
 */
function lanAddresses() {
  const result = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of interfaces || []) {
      if (iface.internal || iface.family !== "IPv4" || iface.address.startsWith("169.254.")) continue;
      result.push({ address: iface.address, interface: name });
    }
  }
  return result.sort((a, b) => rank(a.address) - rank(b.address));
}

module.exports = { lanAddresses };
