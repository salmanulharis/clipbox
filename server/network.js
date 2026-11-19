'use strict';
const os = require('os');

const VIRTUAL = /(vethernet|virtualbox|vmware|vbox|docker|wsl|hyper-v|loopback|tailscale|zerotier|utun|bridge|br-|veth)/i;

/**
 * List IPv4 addresses other devices can use to reach this machine,
 * best guesses (physical Wi-Fi / Ethernet, 192.168.x) first.
 */
function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ iface: name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  const score = (x) =>
    (x.virtual ? 100 : 0) +
    (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 1 : x.address.startsWith('172.') ? 2 : 3);
  return out.sort((a, b) => score(a) - score(b));
}

function localUrls(config) {
  const proto = config.https ? 'https' : 'http';
  const port = config.port;
  const portPart = (proto === 'http' && port === 80) || (proto === 'https' && port === 443) ? '' : `:${port}`;
  const bindAll = ['0.0.0.0', '::', ''].includes(config.host);
  const addrs = bindAll
    ? localAddresses()
    : [{ iface: 'configured', address: config.host, virtual: false }];
  return addrs
    .filter((a) => !['127.0.0.1', 'localhost'].includes(a.address))
    .map((a) => ({ label: a.iface, url: `${proto}://${a.address}${portPart}`, virtual: a.virtual }));
}

module.exports = { localAddresses, localUrls };
