import net from 'node:net';

const RFB_VERSION = 'RFB 003.008\n';
const SECURITY_NONE = 1;
const CLIENT_CUT_TEXT = 6;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Puts text on a demo browser's clipboard through its VNC server, the way a VNC viewer
 * syncs its clipboard (RFB ClientCutText). It is a VNC client that never asks for screen
 * updates. The connection stays open: Xvnc offers the text to X applications (Chromium's
 * Ctrl+V) only while the client that sent it is connected.
 */
export class VncClipboard {
  constructor({ host, port }, log) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.connecting = null;
  }

  /** Resolves with a socket that completed the RFB handshake (security type None). */
  connect() {
    this.connecting ??= new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let buffer = Buffer.alloc(0);
      let stage = 'version';
      const fail = (error) => {
        this.connecting = null;
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('VNC handshake timed out')), CONNECT_TIMEOUT_MS);

      const take = (length) => {
        if (buffer.length < length) return null;
        const part = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        return part;
      };

      socket.on('data', (chunk) => {
        if (stage === 'ready') return; // Server messages (e.g. its own clipboard) are not needed.
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (stage === 'version') {
            if (!take(RFB_VERSION.length)) return;
            socket.write(RFB_VERSION);
            stage = 'security';
          } else if (stage === 'security') {
            if (buffer.length < 1 || buffer.length < 1 + buffer[0]) return;
            const types = [...take(1 + buffer[0]).subarray(1)];
            if (!types.includes(SECURITY_NONE)) return fail(new Error(`VNC server offers no unauthenticated access (types ${types.join(', ') || 'none'})`));
            socket.write(Buffer.from([SECURITY_NONE]));
            stage = 'result';
          } else if (stage === 'result') {
            const result = take(4);
            if (!result) return;
            if (result.readUInt32BE(0) !== 0) return fail(new Error('VNC server refused the connection'));
            socket.write(Buffer.from([1])); // ClientInit: shared, so the viewers stay connected.
            stage = 'init';
          } else if (stage === 'init') {
            // ServerInit: width, height (2 + 2), pixel format (16), name length (4), name.
            if (buffer.length < 24 || buffer.length < 24 + buffer.readUInt32BE(20)) return;
            take(24 + buffer.readUInt32BE(20));
            stage = 'ready';
            clearTimeout(timer);
            resolve(socket);
            return;
          }
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        this.connecting = null;
      });
    });
    return this.connecting;
  }

  /** Replaces the browser's clipboard text (Latin-1, as RFB's basic clipboard requires). */
  async write(text) {
    const socket = await this.connect();
    const data = Buffer.from(String(text), 'latin1');
    const header = Buffer.alloc(8);
    header.writeUInt8(CLIENT_CUT_TEXT, 0);
    header.writeUInt32BE(data.length, 4);
    socket.write(Buffer.concat([header, data]));
  }
}
