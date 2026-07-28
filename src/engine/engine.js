'use strict';
/**
 * Discord bot: receives per-user voice, decodes Opus, resamples to 16 kHz mono
 * and feeds a Vosk worker thread. Speaks a small JSON protocol over process IPC
 * — see `handleCommand`.
 *
 * Runs as a child process so FFI modules load against plain Node rather than
 * Electron's ABI, a bot crash can't take the window down, and it can be driven
 * headless (`npm run engine:headless`).
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { Client, GatewayIntentBits, ChannelType, Events } = require('discord.js');
const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const prism = require('prism-media');

const { Resampler48kStereoTo16kMono } = require('./resample');
const { resolveModelPath } = require('../shared/paths');

/** Discord always sends 48 kHz stereo Opus; 960 samples = 20 ms per frame. */
const OPUS = { rate: 48000, channels: 2, frameSize: 960 };

// Gigaspeech takes ~33s to load, so the model timeout is generous.
const MODEL_LOAD_TIMEOUT_MS = 300_000;
const GATEWAY_READY_TIMEOUT_MS = 30_000;

/**
 * Every await in the start path is bounded. An unbounded one leaves the UI
 * stuck on "Linking" with nothing to tell the user.
 */
function onceWithTimeout(emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      fn(arg);
    };
    const onEvent = (value) => done(resolve, value);
    const timer = setTimeout(
      () => done(reject, new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs
    );
    emitter.once(event, onEvent);
  });
}

class ChatterlayerEngine {
  constructor(emit) {
    this.emit = emit;
    this.client = null;
    this.connection = null;
    this.receiver = null;
    this.channel = null;
    this.worker = null;
    /** userIds the streamer has toggled ON */
    this.selected = new Set();
    /** userId -> { opusStream, decoder, resampler } */
    this.streams = new Map();
    this.workerReady = false;
    this.stopping = false;
    /** userId -> consecutive stream restarts, so a broken stream can't spin. */
    this.restarts = new Map();
  }

  log(level, message) {
    this.emit({ type: 'log', level, message });
  }

  // ---------------------------------------------------------------- Vosk ---

  startWorker(modelPath) {
    return new Promise((resolve, reject) => {
      const resolved = resolveModelPath(modelPath);
      this.emit({ type: 'vosk', state: 'loading', modelPath: resolved });

      this.worker = new Worker(path.join(__dirname, 'vosk-worker.js'), {
        workerData: { modelPath: resolved },
      });

      // Settle exactly once. Without this, a worker that dies during startup
      // (bad model path, missing libvosk) left this promise pending forever and
      // start() simply never returned.
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        resolve();
      };
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        this.emit({ type: 'vosk', state: 'error', message });
        reject(new Error(message));
      };

      const loadTimer = setTimeout(
        () =>
          fail(
            `The speech model at "${resolved}" did not finish loading within ` +
              `${Math.round(MODEL_LOAD_TIMEOUT_MS / 1000)}s. It may be corrupt — re-run "npm run setup".`
          ),
        MODEL_LOAD_TIMEOUT_MS
      );

      this.worker.on('message', (msg) => {
        switch (msg.type) {
          case 'ready':
            this.workerReady = true;
            this.emit({ type: 'vosk', state: 'ready', ...msg });
            return succeed();
          case 'fatal':
            return fail(msg.message);
          case 'partial':
          case 'final':
            return this.emitCaption(msg);
          case 'partialCleared':
            return this.emit({ type: 'captionCleared', userId: msg.userId });
          case 'stats':
            return this.emit({ type: 'stats', ...msg });
          case 'speakerAdded':
          case 'speakerRemoved':
            return this.emit({ type: 'stats', rss: msg.rss, speakers: this.selected.size });
          case 'error':
            return this.log('warn', `[vosk] ${msg.message}`);
          default:
            return undefined;
        }
      });

      this.worker.on('error', (err) => {
        this.workerReady = false;
        fail(`Speech engine failed to start: ${err.message}`);
      });
      this.worker.on('exit', (code) => {
        this.workerReady = false;
        // Only an *unexpected* exit is a failure; a clean shutdown after
        // start() succeeded must not reject anything.
        if (code !== 0) fail(`Speech engine exited unexpectedly (code ${code}).`);
      });
    });
  }

  /** Attach the speaker's display name before handing the caption upstream. */
  emitCaption({ type, userId, text }) {
    const member = this.channel?.members?.get(userId);
    const username =
      member?.displayName || member?.user?.username || this.knownName(userId) || 'Unknown';
    this.emit({
      type: 'caption',
      userId,
      username,
      text,
      isFinal: type === 'final',
      timestamp: Date.now(),
    });
  }

  knownName(userId) {
    return this.client?.users?.cache?.get(userId)?.username || null;
  }

  // ------------------------------------------------------------- Discord ---

  async start({ token, channelId, modelPath }) {
    if (!token) throw new Error('No bot token provided.');
    if (!channelId) throw new Error('No voice channel ID provided.');

    await this.startWorker(modelPath);

    this.emit({ type: 'status', state: 'connecting', message: 'Logging in to Discord…' });

    // Non-privileged intents only. Voice-state payloads carry the member
    // object, so nobody has to enable "Server Members" in the dev portal.
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.client.on('error', (err) => this.log('error', `Discord client error: ${err.message}`));

    // Keep the member list live as people join/leave/move.
    this.client.on('voiceStateUpdate', (oldState, newState) => {
      if (!this.channel) return;
      if (oldState.channelId === this.channel.id || newState.channelId === this.channel.id) {
        // A user who left should stop consuming a recognizer.
        if (oldState.channelId === this.channel.id && newState.channelId !== this.channel.id) {
          this.teardownStream(oldState.id);
        }
        this.emitMembers();
      }
    });

    await this.client.login(token);

    // login() resolves when the handshake starts, not when the client is
    // usable. Until READY, client.user is null and the gateway can't deliver
    // the voice state update joinVoiceChannel needs — the voice connection
    // would silently never come up.
    if (!this.client.isReady()) {
      this.emit({
        type: 'status',
        state: 'connecting',
        message: 'Waiting for Discord to finish connecting…',
      });
      await onceWithTimeout(
        this.client,
        Events.ClientReady,
        GATEWAY_READY_TIMEOUT_MS,
        'Discord gateway connection'
      );
    }

    this.emit({
      type: 'status',
      state: 'authenticated',
      message: `Signed in as ${this.client.user.tag}`,
      botTag: this.client.user.tag,
    });

    this.emit({
      type: 'status',
      state: 'connecting',
      message: `Looking up channel ${channelId}…`,
    });
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      throw new Error(
        `Could not find channel ${channelId}. Check the ID and that the bot is in that server.`
      );
    }
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      throw new Error(`Channel ${channelId} is not a voice channel.`);
    }
    this.channel = channel;

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // a deafened bot receives no audio at all
      selfMute: true,

      // Never set `daveEncryption: false`. It goes out as
      // max_dave_protocol_version: 0 in the voice IDENTIFY, and Discord then
      // never sends SESSION_DESCRIPTION — the bot appears in the channel (that
      // is the main gateway) but the voice connection never reaches Ready and
      // the join times out after 30s.

      // Default is 36 consecutive failures, after which @discordjs/voice throws
      // and destroys the audio stream. A speaker we can't decrypt should lose
      // captions, not take the stream down.
      decryptionFailureTolerance: 5000,
    });

    this.connection.on('error', (err) =>
      this.log('error', `Voice connection error: ${err.message}`)
    );

    // Debug is on by default in @discordjs/voice (only `debug: false` disables
    // it), and the stream dumps whole state objects. Keep the lines that
    // explain a failed handshake or an encryption mismatch.
    const VOICE_DEBUG =
      /dave|transition|downgrade|encryption|session description|udp|select protocol|decrypt/i;
    let lastDecryptLog = 0;
    this.connection.on('debug', (message) => {
      const line = String(message).split('\n')[0];
      if (!VOICE_DEBUG.test(line)) return;
      // Decrypt failures arrive at packet rate; one line every few seconds is
      // enough to diagnose without burying everything else.
      if (/decrypt/i.test(line)) {
        const now = Date.now();
        if (now - lastDecryptLog < 3000) return;
        lastDecryptLog = now;
      }
      this.log('info', `[voice] ${line.slice(0, 180)}`);
    });

    // Discord moves voice servers occasionally; try to ride it out before
    // giving up, otherwise captions would die mid-stream.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.stopping) return;
      this.log('warn', 'Voice disconnected — attempting to resume…');
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        this.log('info', 'Voice connection resumed.');
      } catch {
        this.log('error', 'Could not resume voice connection.');
        this.emit({ type: 'status', state: 'disconnected', message: 'Voice disconnected.' });
        this.connection.destroy();
      }
    });

    this.emit({
      type: 'status',
      state: 'connecting',
      message: `Joining voice channel #${channel.name}…`,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      this.connection.destroy();
      throw new Error(
        `Could not join #${channel.name} within 30s. Check the bot has ` +
          `"View Channel" and "Connect" on that channel, and that the channel isn't full.`
      );
    }
    this.receiver = this.connection.receiver;

    // Vosk does its own endpointing, but flushing on Discord's signal makes
    // trailing words appear without waiting for a packet that may never come.
    this.receiver.speaking.on('end', (userId) => {
      if (this.selected.has(userId) && this.workerReady) {
        this.worker.postMessage({ type: 'flush', userId });
      }
    });

    this.emit({
      type: 'status',
      state: 'joined',
      message: `Listening in #${channel.name}`,
      channelName: channel.name,
      guildName: channel.guild.name,
    });

    this.emitMembers();
    // Anyone toggled on before we joined should start capturing now.
    for (const userId of this.selected) this.setupStream(userId);
  }

  /** Everyone currently in the voice channel, excluding the bot itself. */
  emitMembers() {
    if (!this.channel) return;
    const members = [...this.channel.members.values()]
      .filter((m) => m.id !== this.client.user.id)
      .map((m) => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName || m.user.username,
        bot: Boolean(m.user.bot),
        selected: this.selected.has(m.id),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.emit({ type: 'members', members });
  }

  // ------------------------------------------------- per-speaker capture ---

  /**
   * Persistent subscription (EndBehaviorType.Manual) rather than subscribing on
   * each `speaking start` — the latter races the first voice packet and clips
   * the first word of every utterance. Discord sends nothing during silence, so
   * an idle subscription is free.
   */
  setupStream(userId) {
    if (!this.receiver || this.streams.has(userId) || !this.workerReady) return;

    this.worker.postMessage({ type: 'add', userId });

    const opusStream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder(OPUS);
    const resampler = new Resampler48kStereoTo16kMono();

    decoder.on('data', (stereo48k) => {
      if (!this.workerReady || !this.selected.has(userId)) return;
      // Audio is flowing again — clear any earlier restart budget.
      if (this.restarts.get(userId)) this.restarts.delete(userId);
      const mono16k = resampler.process(stereo48k);
      if (!mono16k.length) return;
      // Detach from Node's Buffer pool so the ArrayBuffer can be transferred
      // to the worker with zero copying.
      const ab = mono16k.buffer.slice(
        mono16k.byteOffset,
        mono16k.byteOffset + mono16k.byteLength
      );
      this.worker.postMessage({ type: 'audio', userId, buf: ab }, [ab]);
    });

    // A stream error destroys the pipe, leaving that speaker silent for the
    // rest of the call. Rebuild instead, with a budget so a permanently broken
    // stream can't spin.
    const MAX_RESTARTS = 5;
    let handled = false;
    const onError = (err) => {
      if (handled) return; // both opusStream and decoder can fire for one fault
      handled = true;

      const who = this.knownName(userId) || userId;
      const count = (this.restarts.get(userId) || 0) + 1;
      this.restarts.set(userId, count);

      if (!this.selected.has(userId) || count > MAX_RESTARTS) {
        this.log(
          'error',
          `Audio stream for ${who} failed: ${err.message}` +
            (count > MAX_RESTARTS ? ' — giving up. Toggle them off and on to retry.' : '')
        );
        this.teardownStream(userId);
        return;
      }

      this.log('warn', `Audio stream for ${who} failed (${err.message}) — reconnecting…`);
      this.teardownStream(userId);
      setTimeout(() => {
        if (this.selected.has(userId)) this.setupStream(userId);
      }, 1000).unref();
    };
    opusStream.on('error', onError);
    decoder.on('error', onError);

    opusStream.pipe(decoder);
    this.streams.set(userId, { opusStream, decoder, resampler });
    this.log('info', `Capturing audio for ${this.knownName(userId) || userId}`);
  }

  teardownStream(userId) {
    const s = this.streams.get(userId);
    if (!s) return;
    try {
      s.opusStream.unpipe(s.decoder);
      s.opusStream.destroy();
      s.decoder.destroy();
    } catch {
      /* already torn down */
    }
    this.streams.delete(userId);
    if (this.workerReady) this.worker.postMessage({ type: 'remove', userId });
  }

  /** Live toggle. Safe to call at any time, including mid-call. */
  setSelected(userIds) {
    const next = new Set(userIds);
    for (const userId of this.selected) {
      if (!next.has(userId)) {
        this.teardownStream(userId);
        // Toggling someone off and on is the documented way to retry a stream
        // that exhausted its restart budget, so reset it here.
        this.restarts.delete(userId);
      }
    }
    this.selected = next;
    for (const userId of next) {
      if (!this.streams.has(userId)) this.setupStream(userId);
    }
    this.emitMembers();
    this.emit({ type: 'stats', speakers: this.selected.size });
  }

  // -------------------------------------------------------------- teardown --

  async stop() {
    this.stopping = true;
    this.restarts.clear();
    for (const userId of [...this.streams.keys()]) this.teardownStream(userId);

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        /* may already be destroyed */
      }
      this.connection = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    if (this.worker) {
      // Capture the reference — if Start is hit again within the grace period,
      // `this.worker` points at a new worker and the timer would kill it.
      const dying = this.worker;
      this.worker = null;
      this.workerReady = false;
      dying.postMessage({ type: 'shutdown' });
      // Give it a moment to free the model, then force it down.
      setTimeout(() => dying.terminate(), 1000).unref();
    }
    this.channel = null;
    this.receiver = null;
    this.stopping = false;
    this.emit({ type: 'status', state: 'stopped', message: 'Stopped.' });
  }
}

// ---------------------------------------------------------------- IPC glue --

const emit = (msg) => {
  if (process.send) process.send(msg);
  else if (process.env.CHATTERLAYER_VERBOSE) console.log(JSON.stringify(msg));
};

const engine = new ChatterlayerEngine(emit);

async function handleCommand(msg) {
  try {
    switch (msg.type) {
      case 'start':
        return await engine.start(msg);
      case 'setSelected':
        return engine.setSelected(msg.userIds || []);
      case 'requestMembers':
        return engine.emitMembers();
      case 'stats':
        return engine.worker && engine.worker.postMessage({ type: 'stats' });
      case 'stop':
        return await engine.stop();
      case 'shutdown':
        await engine.stop();
        return process.exit(0);
      default:
        return undefined;
    }
  } catch (err) {
    emit({ type: 'status', state: 'error', message: err.message });
    emit({ type: 'log', level: 'error', message: err.stack || err.message });
    return undefined;
  }
}

process.on('message', handleCommand);

process.on('uncaughtException', (err) => {
  emit({ type: 'log', level: 'error', message: `uncaught: ${err.stack || err.message}` });
  emit({ type: 'status', state: 'error', message: err.message });
});
process.on('unhandledRejection', (err) => {
  const e = err instanceof Error ? err : new Error(String(err));
  emit({ type: 'log', level: 'error', message: `unhandled: ${e.stack || e.message}` });
});

// Headless mode: `node src/engine/engine.js --headless` with env vars set,
// useful for debugging the bot without launching Electron.
if (process.argv.includes('--headless')) {
  process.env.CHATTERLAYER_VERBOSE = '1';
  handleCommand({
    type: 'start',
    token: process.env.DISCORD_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
  }).then(() => {
    if (process.env.CHATTERLAYER_SELECT) {
      engine.setSelected(process.env.CHATTERLAYER_SELECT.split(','));
    }
  });
}

module.exports = { ChatterlayerEngine };
