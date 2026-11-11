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
import { scenarios } from './scenarios/index.js';

const ROLES = ['victim', 'attacker'];

const log = createLogger('server');
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(appRoot, 'public');
const auth = createBasicAuth(config.auth);

if (!auth.enabled) {
  log.warn('DEMO_PASSWORD is empty: the demos (including the remote browsers) are reachable without authentication');
}

for (const id of config.demos) {
  if (!scenarios.has(id)) throw new Error(`Unknown demo "${id}" in DEMOS (available: ${[...scenarios.keys()].join(', ')})`);
}

const catalog = config.demos.map((id) => ({ id, title: scenarios.get(id).title }));
const demos = new Map(config.demos.map((id) => {
  const browsers = Object.fromEntries(ROLES.map((role) => [
    role,
    new BrowserController(role, config.browserTarget(id, role), { learningUrl: config.learningUrl, passkeysToolsUrl: config.passkeysToolsUrl }),
  ]));
  return [id, new DemoController(scenarios.get(id), browsers, config, catalog)];
}));

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(auth.middleware);
app.get('/api/demos', (_req, res) => res.json([...demos.values()].map((demo) => demo.summary())));
app.use('/vendor', express.static(path.join(appRoot, 'dist'), { maxAge: '1h' }));
app.use(express.static(publicDir));
app.get('/:demoId', (req, res, next) => {
  if (!demos.has(req.params.demoId)) return next();
  return res.sendFile(path.join(publicDir, 'demo.html'));
});

const server = http.createServer(app);
const stateSockets = new WebSocketServer({ noServer: true });
const vncSockets = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
});

for (const [id, demo] of demos) {
  demo.on('state', (serialized) => {
    for (const client of stateSockets.clients) {
      if (client.demoId === id && client.readyState === client.OPEN) client.send(serialized);
    }
  });
}

server.on('upgrade', (req, socket, head) => {
  if (!auth.isAuthorized(req.headers)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Passkeys demo"\r\n\r\n');
    socket.destroy();
    return;
  }
  const { pathname } = new URL(req.url, 'http://localhost');

  const stateMatch = /^\/ws\/([\w-]+)$/.exec(pathname);
  if (stateMatch && demos.has(stateMatch[1])) {
    const demo = demos.get(stateMatch[1]);
    stateSockets.handleUpgrade(req, socket, head, (ws) => {
      ws.demoId = stateMatch[1];
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
    return;
  }

  const vncMatch = /^\/vnc\/([\w-]+)\/(victim|attacker)$/.exec(pathname);
  if (vncMatch && demos.has(vncMatch[1])) {
    const target = config.browserTarget(vncMatch[1], vncMatch[2]);
    vncSockets.handleUpgrade(req, socket, head, (ws) => bridgeVnc(ws, { host: target.host, port: target.vncPort }, log));
    return;
  }
  socket.destroy();
});

server.listen(config.port, () => {
  log.info(`listening on :${config.port} with demos: ${config.demos.join(', ')}`);
  for (const demo of demos.values()) demo.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close();
    process.exit(0);
  });
}
