'use strict';
/**
 * Serves the OBS overlay page and hosts the WebSocket feed it consumes. Sharing
 * one port lets the overlay derive its socket URL from its own location, so
 * there is nothing to configure in OBS beyond the URL.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WEB_DIR } = require('../shared/paths');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Friendly aliases so streamers can type short URLs. */
const ROUTES = {
  '/': 'overlay.html',
  '/overlay': 'overlay.html',
  '/overlay.html': 'overlay.html',
};

class CaptionServer {
  constructor() {
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.settings = { overlay: {} };
  }

  get port() {
    const addr = this.server && this.server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  urls(host) {
    const p = this.port;
    if (!p) return { overlay: null };
    const h = host === '0.0.0.0' ? '127.0.0.1' : host;
    return { overlay: `http://${h}:${p}/overlay` };
  }

  start({ port = 8777, host = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttp(req, res));

      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        // Send current styling so the overlay renders correctly straight away.
        // Deliberately NO caption backlog: OBS reloads the browser source on
        // scene changes, and replaying old speech would put words back on
        // stream seconds after they were said.
        ws.send(JSON.stringify({ type: 'hello', settings: this.settings }));
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${port} is already in use. Pick a different port in Chatterlayer's settings.`
            )
          );
        } else {
          reject(err);
        }
      });

      this.server.listen(port, host, () => resolve(this.urls(host)));
    });
  }

  handleHttp(req, res) {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filename = ROUTES[urlPath] || urlPath.replace(/^\/+/, '');

    // Resolve inside WEB_DIR and reject anything that escapes it.
    const filePath = path.resolve(WEB_DIR, filename);
    if (!filePath.startsWith(path.resolve(WEB_DIR))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        // Overlay pages are reloaded constantly while tweaking; never cache.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  sendCaption(caption) {
    this.broadcast({ type: 'caption', ...caption });
  }

  /** Push styling changes live — no OBS refresh needed. */
  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this.broadcast({ type: 'settings', settings: this.settings });
  }

  clearCaptions() {
    this.broadcast({ type: 'clear' });
  }

  async stop() {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }
}

module.exports = { CaptionServer };
