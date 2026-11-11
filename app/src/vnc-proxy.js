import net from 'node:net';

/**
 * Bridges a noVNC WebSocket to a browser container's raw VNC (RFB) TCP port,
 * like websockify does.
 */
export function bridgeVnc(ws, { host, port }, log) {
  const socket = net.connect({ host, port });

  socket.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  ws.on('message', (data) => {
    if (!socket.destroyed) socket.write(data);
  });

  socket.on('error', (error) => {
    log.warn(`VNC connection to ${host}:${port} failed: ${error.message}`);
    ws.close(1011, 'VNC backend unavailable');
  });
  socket.on('close', () => ws.close());
  ws.on('close', () => socket.destroy());
  ws.on('error', () => socket.destroy());
}
