import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { createBasicAuth } from './auth.js';
import { createLogger } from './log.js';
import { bridgeVnc } from './vnc-proxy.js';
import { BrowserController } from './browser-controller.js';
import { DemoController } from './demo.js';

const log = createLogger('server');
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const auth = createBasicAuth(config.auth);

if (!auth.enabled) {
  log.warn('DEMO_PASSWORD is empty: the demo (including both remote browsers) is reachable without authentication');
}

const browsers = Object.fromEntries(Object.entries(config.browsers).map(([role, target]) => [
  role,
  new BrowserController(role, target, { learningUrl: config.learningUrl, passkeysToolsUrl: config.passkeysToolsUrl }),
]));
const demo = new DemoController(browsers, config);

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(auth.middleware);
app.use('/vendor', express.static(path.join(appRoot, 'dist'), { maxAge: '1h' }));
app.use(express.static(path.join(appRoot, 'public')));

const server = http.createServer(app);
const stateSockets = new WebSocketServer({ noServer: true });
const vncSockets = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
});

stateSockets.on('connection', (ws) => {
  ws.send(demo.latestState());
  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    demo.handleAction(message);
  });
});

demo.on('state', (serialized) => {
  for (const client of stateSockets.clients) {
    if (client.readyState === client.OPEN) client.send(serialized);
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!auth.isAuthorized(req.headers)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Passkeys demo"\r\n\r\n');
    socket.destroy();
    return;
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') {
    stateSockets.handleUpgrade(req, socket, head, (ws) => stateSockets.emit('connection', ws, req));
    return;
  }
  const vncMatch = /^\/vnc\/(victim|attacker)$/.exec(pathname);
  if (vncMatch) {
    const target = config.browsers[vncMatch[1]];
    vncSockets.handleUpgrade(req, socket, head, (ws) => bridgeVnc(ws, { host: target.host, port: target.vncPort }, log));
    return;
  }
  socket.destroy();
});

server.listen(config.port, () => {
  log.info(`listening on :${config.port}`);
  demo.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close();
    process.exit(0);
  });
}
