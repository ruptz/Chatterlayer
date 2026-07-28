'use strict';
/**
 * Owns the engine child process and relays its JSON messages.
 *
 * Spawned with ELECTRON_RUN_AS_NODE, which runs the Electron binary as plain
 * Node — so an installed build needs no separate Node runtime.
 */

const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');

const ENGINE_PATH = path.join(__dirname, '..', 'engine', 'engine.js');

class EngineHost extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.running = false;
    /** Remembered so we can restore state if the engine has to be restarted. */
    this.lastStart = null;
    this.selected = [];
  }

  spawn() {
    if (this.child) return this.child;

    this.child = fork(ENGINE_PATH, [], {
      // Run Electron's bundled Node instead of requiring a system Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // Surface engine stdout/stderr as log events rather than losing them.
    this.child.stdout.on('data', (d) =>
      this.emit('message', { type: 'log', level: 'info', message: d.toString().trim() })
    );
    this.child.stderr.on('data', (d) =>
      this.emit('message', { type: 'log', level: 'error', message: d.toString().trim() })
    );

    this.child.on('message', (msg) => this.emit('message', msg));

    this.child.on('exit', (code, signal) => {
      this.child = null;
      const wasRunning = this.running;
      this.running = false;
      if (wasRunning) {
        this.emit('message', {
          type: 'status',
          state: 'error',
          message: `Engine stopped unexpectedly (code ${code ?? signal}). Press Start to retry.`,
        });
      }
    });

    this.child.on('error', (err) =>
      this.emit('message', { type: 'status', state: 'error', message: err.message })
    );

    return this.child;
  }

  async start(opts) {
    this.spawn();
    this.lastStart = opts;
    this.running = true;
    this.child.send({ type: 'start', ...opts });
  }

  setSelected(userIds) {
    this.selected = userIds;
    if (this.child) this.child.send({ type: 'setSelected', userIds });
  }

  requestMembers() {
    if (this.child) this.child.send({ type: 'requestMembers' });
  }

  requestStats() {
    if (this.child) this.child.send({ type: 'stats' });
  }

  async stop() {
    this.running = false;
    if (!this.child) return;
    this.child.send({ type: 'stop' });
  }

  async shutdown() {
    this.running = false;
    if (!this.child) return;
    const child = this.child;
    child.send({ type: 'shutdown' });
    // Don't let a wedged engine hold up app quit.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 2500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }
}

module.exports = { EngineHost };
