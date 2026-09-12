/**
 * Zero-dependency static server for local play.
 *
 *   npm start            -> http://localhost:5173
 *   npm start -- 8080    -> a different port
 *
 * ES modules and the solver Web Worker both need a real http origin, which is
 * why opening index.html straight off disk is not enough.
 *
 * The socket listens on every interface, so a phone on the same Wi-Fi can play
 * at the http://<this machine's LAN IP>:<port>/ address printed on startup.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 5173);
// Listening on 0.0.0.0 is what lets other devices on the network connect.
// Set HOST=127.0.0.1 to go back to this machine only.
const host = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// Adapters a phone can never reach: VM host-only networks, WSL, Hyper-V switches.
const VIRTUAL = /virtual|vethernet|vmware|hyper-v|wsl|docker|loopback/i;

/** Every non-loopback IPv4 address of this machine, likeliest one first. */
function lanAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      const family = address.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (address.internal) continue;
      found.push({ ip: address.address, virtual: VIRTUAL.test(name) });
    }
  }
  // 192.168.x and 10.x are the usual home-router ranges; 169.254.x never routes.
  const rank = ({ ip, virtual }) => {
    if (virtual) return 4;
    if (ip.startsWith('169.254.')) return 3;
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    return 2;
  };
  return found.sort((a, b) => rank(a) - rank(b)).map(({ ip }) => ip);
}

/**
 * The address the OS would use to reach the wider network — the one a phone on
 * the same Wi-Fi should be given. Connecting a UDP socket sends no packets; it
 * only asks the routing table which local interface would carry the traffic,
 * which is the one piece of truth `networkInterfaces()` cannot tell us (a
 * VirtualBox or Hyper-V adapter looks exactly like the real Wi-Fi card).
 */
function primaryAddress() {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (value) => {
      try {
        socket.close();
      } catch {}
      resolve(value);
    };
    socket.once('error', () => done(null));
    try {
      socket.connect(53, '1.1.1.1', () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const wanted = decodeURIComponent(url.pathname);
    const relative = normalize(wanted === '/' ? '/index.html' : wanted).replace(/^([/\\])+/, '');

    // Never serve outside the project directory.
    const filePath = join(root, relative);
    if (!filePath.startsWith(root + sep) && filePath !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);

    response.writeHead(200, {
      'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, host, async () => {
  console.log('Tessera is running.');
  console.log(`  On this PC:    http://localhost:${port}/`);

  const primary = await primaryAddress();
  const others = lanAddresses().filter((ip) => ip !== primary);
  if (primary) {
    console.log(`  On your phone: http://${primary}:${port}/   (same Wi-Fi)`);
  }
  for (const ip of others) {
    console.log(`  also reachable at http://${ip}:${port}/`);
  }
  if (!primary && !others.length) {
    console.log('  No network address found - only this machine can reach the game.');
  }
});
