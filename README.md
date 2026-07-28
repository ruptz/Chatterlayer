# Chatterlayer

Live, colour-coded captions for Discord voice calls, rendered in OBS.

Built for Twitch streamers who host multi-person Discord calls and want their
viewers to know **who said what** — including viewers who are deaf or hard of
hearing, watching muted, or on a bad connection.

**Free, forever, for everyone.** No paid tiers, no licence keys, no accounts, no
API keys, no per-minute billing. Speech recognition runs entirely on your own
machine via [Vosk](https://alphacephei.com/vosk/). After the one-time setup
download, Chatterlayer never sends your audio anywhere — it does not need an
internet connection to transcribe.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Create your Discord bot](#create-your-discord-bot)
- [Get the voice channel ID](#get-the-voice-channel-id)
- [Run it](#run-it)
- [Add the overlay to OBS](#add-the-overlay-to-obs)
- [Word filter](#word-filter)
- [Performance: RAM, CPU, latency](#performance-ram-cpu-latency)
- [Accuracy vs paid speech services](#accuracy-vs-paid-speech-services)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Shipping a release](#shipping-a-release)
- [Licence](#licence)

---

## What it does

- Joins a Discord voice channel as a bot and lists everyone in the call.
- You tick **only the people you want captioned** — toggleable live, mid-call.
- Each selected person's audio is transcribed **separately** (Discord provides
  per-user audio streams natively), so speakers never get mixed up.
- Every speaker gets a stable colour derived from their Discord user ID —
  **guaranteed distinct within a call** (see [below](#speaker-colours)) — and
  overridable in the UI.
- Captions are broadcast over a local WebSocket to an **OBS browser source**,
  burned into your stream.

---

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer (developed and tested on 22) |
| **OS** | Windows x64, macOS (Intel/Apple Silicon), or Linux x64/arm64 |
| **Disk** | ~250 MB (Electron + Vosk runtime + small English model) |
| **RAM** | ~400 MB with 1 speaker, ~500 MB with 7 — see [below](#performance-ram-cpu-latency) |
| **Compiler** | **None.** No Visual Studio, no Python, no `node-gyp`. |

---

## Install

Download the latest installer from the
[Releases page](https://github.com/ruptz/Chatterlayer/releases) and run it.
There's a normal installer and a portable build if you'd rather not install
anything.

> Builds are **unsigned**, so Windows SmartScreen warns on first launch.
> Choose *More info* → *Run anyway*.

On first launch Chatterlayer asks which **speech model** to download. Models
aren't bundled — they range from 40 MB to 2.3 GB and you only need one.

### Which model?

| Model | Download | RAM | Load | Relative CPU | Good for |
|---|---|---|---|---|---|
| Small | 40 MB | 152 MB | 0.3 s | 1× | 7 speakers, weak machines |
| **Medium** ⭐ | **128 MB** | **~250 MB** | ~2 s | ~3× | **Almost everyone** |
| Large | 1.8 GB | ~5 GB | ~25 s | ~14× | 1–3 speakers, accuracy first |
| Gigaspeech | 2.3 GB | 6.8 GB | 33 s | ~16× | 1–3 speakers, best accuracy |

**Medium is the recommended default** — clearly better than Small, and light
enough to keep up with a full call. Gigaspeech is the most accurate (trained on
conversational audio rather than audiobooks, so it suits Discord well) but needs
~7 GB of RAM and about 16× the CPU, which is too much for a busy call.

RAM, load times and CPU are measured, not estimated — reproduce with
`npm run bench`.

You can install several models and switch between them in the **Speech model**
picker without re-downloading. Models are stored in your user data folder and
survive app updates; **Remove** frees the disk space.

### From source

```bash
git clone https://github.com/ruptz/Chatterlayer.git
cd Chatterlayer
npm install
npm run setup     # libvosk runtime + the recommended model
npm start
```

Useful scripts:

```bash
npm run setup -- --list          # show every available model
npm run setup -- --model=small   # pick a specific one
npm run setup -- --runtime-only  # libvosk only (what CI uses)
npm run selftest                 # audio, colour and wiring checks
npm run bench                    # RAM + CPU report for the active model
npm run test:vosk -- some.wav    # transcribe a 16 kHz mono WAV
```

---

## Create your Discord bot

Chatterlayer needs a bot account to sit in your voice channel and receive audio.
This takes about two minutes and is free.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it anything (e.g. "Chatterlayer").
2. Open the **Bot** tab → **Add Bot**.
3. Click **Reset Token**, then **Copy**. This is what you paste into
   Chatterlayer. Treat it like a password — anyone with it controls your bot.
4. **You do not need to enable any Privileged Gateway Intents.** Chatterlayer
   only uses `Guilds` and `GuildVoiceStates`, both of which are on by default.
   Leave "Server Members" and "Message Content" switched off.
5. Open **OAuth2 → URL Generator**:
   - **Scopes:** `bot`
   - **Bot Permissions:** `View Channel` and `Connect`
     *(it never speaks, so it does not need `Speak`)*
6. Open the generated URL and invite the bot to your server.

> **A quick shortcut:** this invite URL works once you swap in your own client
> ID —
> `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1049600&scope=bot`

### Consent matters

Everyone in the call is being transcribed to your stream. Tell them, and use the
per-person toggles to caption only the people who have agreed. In some places
recording others without consent is illegal — the toggles exist so you can
respect that by default.

---

## Get the voice channel ID

1. Discord → **User Settings → Advanced → Developer Mode: ON**.
2. Right-click the **voice channel** → **Copy Channel ID**.
3. Paste it into Chatterlayer.

---

## Run it

```bash
npm start
```

1. Paste your **bot token** and **voice channel ID**, then click
   **Join voice channel**.
2. The member list fills with everyone currently in the call.
3. Flip the toggle for each person you want captioned. A Vosk recognizer spins
   up for them the moment you do, and is freed the moment you switch them off.
4. Click a colour swatch to change any speaker's colour. Changes apply to the
   live overlay instantly.
5. **Click a name to change how it appears on captions.** Discord handles are
   rarely what you want on stream — `ruptz_45454` can show as `Ruptz`. The real
   handle stays visible underneath so you can still tell who is who. Clear the
   field to go back to their Discord name. Renames apply to the very next
   caption; nothing reconnects.

Your token is stored encrypted via your OS keystore (DPAPI on Windows, Keychain
on macOS, libsecret on Linux) in `chatterlayer-config.json` inside Electron's
user-data folder. Use **Show config file** in the UI to find it.

---

## Add the overlay to OBS

1. In OBS: **Sources → + → Browser**.
2. **URL:** `http://127.0.0.1:8777/overlay` (copy it from the app).
3. **Width / Height:** match your canvas, e.g. `1920` × `1080`.
4. Tick **Shutdown source when not visible** and
   **Refresh browser when scene becomes active**.
5. Position the source. Captions render bottom-left with a 24 px margin.

The overlay background is fully transparent — OBS composites it over your scene.
It reconnects automatically, so it is safe to add the source before starting
Chatterlayer, and it survives restarting the app mid-stream.

Text size, how long a caption holds, line count, partials and speaker names are
all adjustable in the **Output** panel and apply to the live overlay instantly —
no OBS refresh needed.

The caption server binds to `127.0.0.1`, so it is reachable only from your own
machine. Nothing is exposed to the network.

---

## Word filter

Captions go on stream the moment they're recognised, with no chance to review
them. **Racial and ethnic slurs are masked by default**, in both speech and
speaker names:

```
he called me a *****        <- speech
*****                       <- a slur in someone's Discord name
```

Masking happens in one place, before captions reach OBS or the in-app monitor,
so unmasked text never leaves the app.

**Whole words only.** Substring matching would censor ordinary speech.
A filter that mangles normal sentences gets switched off, which
protects nobody. Plurals are matched automatically, and multi-word slurs are
caught across adjacent words.

**Adding your own.** The **Word filter** panel takes one word or phrase per
line. The built-in list covers racial and ethnic slurs only — other categories
vary by platform and community, so they're yours to set.

Terms that are also ordinary words in common use are deliberately left out of
the defaults, because a false positive mid-sentence is worse than useless. Add
them yourself if your community needs them.

> **This is a safety net, not a guarantee.** Speech recognition mishears things:
> it can miss a slur by transcribing it as something else, and it can invent one
> that nobody said. Treat the filter as one layer, not as permission to leave
> captions unattended.

---

## Performance: RAM, CPU, latency

Measured on this machine — Windows 11, Node 22.13, `vosk-model-small-en-us-0.15`.
Reproduce with `node --expose-gc scripts/bench.js 7`.

### Memory

The acoustic model is loaded **once** and shared by every recognizer, so adding
a speaker costs only a recognizer — not another copy of the model.

| Selected speakers | Engine process RSS |
|---|---|
| model only (0 speakers) | 152 MB |
| 1 | 168 MB |
| 2 | 181 MB |
| 3 | 192 MB |
| 4 | 204 MB |
| 5 | 216 MB |
| 6 | 228 MB |
| 7 | **240 MB** |

- **Shared model:** ~116 MB, paid once.
- **Per additional speaker:** **~12 MB** (the first is ~16 MB).
- **Plus the Electron UI:** roughly 100–180 MB depending on platform.
- **Realistic total for a 7-person call:** **~400–450 MB**.

Switching a speaker off frees their recognizer immediately.

**The model choice dominates everything else.** Per-speaker cost barely moves
between models — it's the shared model that changes:

| Model | Model RAM | Per speaker | 4 speakers total |
|---|---|---|---|
| `small-en-us-0.15` | 116 MB | ~12 MB | **204 MB** |
| `en-us-0.42-gigaspeech` | 6842 MB | ~15 MB | **6939 MB** |

So adding speakers is cheap; adding accuracy is not.

### CPU

The benchmark reports ~0.025× realtime per stream, but **that number is
optimistic** — it uses synthetic noise, which Vosk's silence detection prunes
far more aggressively than real speech. For planning, budget **0.1–0.3× of one
core per actively-talking speaker** on a modern desktop CPU. Seven people all
talking at once is therefore roughly **1–2 cores**, and that peak is rare:
Discord transmits no packets while someone is silent, so idle speakers cost
essentially nothing.

Decoding runs on a **dedicated worker thread**, deliberately: blocking the main
thread would stall the Discord voice socket and drop inbound audio packets.

### Latency

End-to-end, speech → pixels on stream:

| Stage | Typical |
|---|---|
| Discord network + 20 ms Opus framing | ~60–100 ms |
| Resample + queue to worker | <5 ms |
| Vosk partial decode + 120 ms update throttle | ~120–250 ms |
| Local WebSocket + browser paint | <20 ms |
| **Live partial text appears** | **~250–500 ms** |
| **Finalised line** (after the speaker pauses) | **~0.5–1.5 s** |

Partial captions update as someone speaks; the line is rewritten in place when
Vosk finalises the utterance. Turn partials off in the UI if you prefer only
settled text.

---

## Accuracy vs paid speech services

Honest expectations. Vosk's small English model is genuinely good for a 40 MB
offline model, but it is not Whisper-large or Google/AWS/Deepgram.

**Where Vosk small lands:**

- Roughly **85–92%** word accuracy for a clear speaker on a decent mic in a
  quiet room. Paid cloud services typically reach 93–97% on the same audio.
- Degrades faster than cloud models with background noise, music, heavy accents,
  crosstalk, and cheap microphones.
- **No punctuation and no capitalisation.** Output is a lowercase word stream.
- Struggles with proper nouns, game jargon, usernames, and memes — vocabulary is
  fixed and cannot be biased toward your community's terms without building a
  custom model.
- Numbers are transcribed as words ("twenty twenty five").

**Where it wins, and why it's the right pick here:**

- **Free and unmetered.** Cloud STT runs roughly $0.02–0.06 per streamed hour
  *per speaker*. Seven speakers over a 5-hour stream is real money, every
  stream. Chatterlayer costs nothing to run.
- **Private.** Your friends' voices never leave your machine. No provider
  terms, no data retention questions, no consent headaches beyond the people in
  the call.
- **No account, key, quota, or billing to break mid-stream.**
- **Low latency**, because there is no network round-trip.
- **Works offline**, including if your connection wobbles.

**To improve accuracy:** install a bigger model with
`npm run setup -- --model=best` (Gigaspeech) and pick it in the **Speech model**
dropdown. It closes much of the gap to paid services on clear speech, and being
trained on conversational audio it handles Discord chatter noticeably better
than the small model — at ~16× the CPU and 6.8 GB of RAM. See
[Install](#install) for guidance on how many speakers each model can carry.

Mic quality still affects results more than model size does, so a friend on a
bad headset will be the weak link regardless of which model you run.

If you later want near-human accuracy and can spend money, the WebSocket
protocol here is simple enough to swap the recognizer behind it. The
architecture does not assume Vosk beyond `src/engine/vosk-worker.js`.

---

## Troubleshooting

**"Model: NOT FOUND"** — run `npm run setup`.

**Stuck on "Linking" and never connects** — check the **Log** panel, which now
reports each stage (loading model → signing in → waiting for gateway → looking
up channel → joining voice). Every step is time-bounded and will surface a real
error rather than hanging. Common causes:

- The bot isn't in the server, or lacks **View Channel** / **Connect** on that
  specific channel. Channel-level overrides beat server-level ones.
- The channel ID is a *text* channel, or belongs to a server the bot isn't in.
- A large speech model is still loading — Gigaspeech takes ~33 s on first
  connect. The log says which model it is loading.

**Bot joins but no captions appear**
- Confirm you have toggled at least one person **on**. Nobody is captioned by
  default.
- Check the person is actually transmitting (Discord shows a green ring).
- Watch the **Log** panel — recognizer errors surface there.

**"Used disallowed intents"** — you enabled a privileged intent that isn't
needed. Chatterlayer uses only non-privileged intents; turn Server Members and
Message Content back off, or reset the token.

**Bot can't join the channel** — it needs both **View Channel** and **Connect**
on that specific channel. Channel-level permission overrides beat server-level
ones; check the channel's own permission settings.

**Port 8777 already in use** — change the port in the **Output** panel; the
server rebinds immediately. Remember to update the OBS browser source URL.

**Overlay is blank in OBS** — confirm the URL matches the one shown in the
**Output** panel (the port may have changed), and that Chatterlayer is running.
Opening the same URL in a normal browser shows a "connecting" badge if the
overlay can't reach the app.

**Captions lag further and further behind** — you are CPU-bound. Reduce the
number of selected speakers, or switch back to the small model.

**`Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)`** —
this is Discord's DAVE end-to-end encryption, not a Chatterlayer bug.
`@discordjs/voice` advertises E2EE support by default, but E2EE only tolerates
unencrypted frames during brief (~10 s) "passthrough" windows around key
changes. Once that window closes, an unencrypted packet is rejected, and after
enough consecutive failures the audio stream throws and dies mid-call. The
mismatch is easy to trigger, because Discord downgrades a call out of E2EE when
a participant that can't do it joins — which is exactly what a bot is.

**Do not "fix" this by setting `daveEncryption: false`.** It looks like the
obvious answer, and it is a trap: the flag is sent as
`max_dave_protocol_version: 0` in the voice IDENTIFY payload, and Discord then
never completes the handshake. The bot still *appears* in the voice channel —
that part is the main gateway — but the voice connection never receives
`SESSION_DESCRIPTION`, never reaches `Ready`, and the join times out after 30 s
with "Could not join #channel within 30s".

Chatterlayer instead leaves DAVE enabled and raises
`decryptionFailureTolerance`. That matters because of how `@discordjs/voice`
consumes the result (`onUdpMessage`): an undecryptable packet returns nothing
and is **skipped harmlessly**, but once the tolerance is exceeded it *throws*,
and the throw calls `stream.destroy(error)` — killing that speaker's audio for
the rest of the call. With a high tolerance, bad packets are simply dropped.

If it happens, the Log panel shows throttled `[voice] Failed to decrypt…` lines
plus the DAVE transition messages, which is what you need to diagnose it. A
stream that does die is now rebuilt automatically (5 attempts, then it asks you
to toggle the speaker off and on).

**Audio receive stops working after a Discord update** — receiving voice as a
bot is not an officially supported Discord API, though `@discordjs/voice` has
supported it for years. If Discord changes it, this breaks until the library
catches up. Worth knowing before you build a workflow around it.

---

## How it works

```
Discord voice channel
   │  per-user Opus streams (48 kHz stereo)
   ▼
engine process (plain Node, forked)
   │  prism-media  → Opus decode
   │  resample.js  → 48 kHz stereo ➜ 16 kHz mono (25-tap FIR, −59 dB aliasing)
   ▼
vosk-worker (worker thread)
   │  one shared model + one recognizer per selected speaker
   ▼
Electron main  ── adds each speaker's colour ──▶  WebSocket :8777
                                                   └─▶ /overlay  (OBS browser source)
```

**Why the engine is a child process.** Native/FFI modules load against plain
Node instead of Electron's ABI, a bot crash can't take the window down, and it
can be run headless (`npm run engine:headless`) for debugging.

**Why not the `vosk` npm package.** It binds libvosk through `ffi-napi`, which
has been unmaintained since 2022 and fails to compile on Node 18+ (`ffi-napi`'s
bundled libffi errors out during assembly preprocessing). Forcing it to build
would require every user to install Visual Studio Build Tools and Python, plus
an `electron-rebuild` pass. Chatterlayer instead binds the **same official
libvosk** through [koffi](https://koffi.dev/), which ships prebuilt N-API
binaries — so the same install works on Node and Electron with no toolchain.
See `src/engine/vosk-binding.js`.

### Speaker colours

Colours are hashed from the Discord user ID so the same person looks the same
across sessions and machines, with no configuration. But hashing alone is not
enough: with a 16-colour palette, **seven random users collide about 78% of the
time** (the birthday bound — measured, not theoretical), and two speakers
sharing a colour defeats the whole point.

So Chatterlayer assigns colours across the *whole call* at once. Each person
prefers their hashed colour; when two want the same one, the assignment probes
forward through the palette. Iterating in sorted ID order keeps it deterministic
— the same group always gets the same colours. Manual overrides are reserved
first and always win.

Result: **0% duplicate colours** for calls up to 16 people, while 81% of
speakers still keep their preferred colour. Past 16 concurrent speakers the
palette is exhausted and duplicates become unavoidable.

**Why persistent audio subscriptions.** Subscribing on each `speaking start`
event races the first voice packet and clips the first word of every utterance.
Chatterlayer holds a persistent subscription per selected speaker and uses
speaking events only to flush utterance boundaries. Discord sends no packets
during silence, so idle subscriptions are free.

### Project layout

```
src/
  main/       Electron main process — window, config, server, engine supervisor
  engine/     Discord bot, Opus decode, resampling, Vosk worker + FFI binding
  renderer/   Control panel UI
  shared/     Colour hashing and path resolution
web/
  overlay.html    OBS browser source
scripts/
  setup-vosk.js   Downloads runtime + model
  test-vosk.js    Transcribe a WAV to verify the engine
  bench.js        RAM and CPU report
```

---

## Shipping a release

**You don't build releases on your own machine — CI does.** Cutting a release is
two commands:

```bash
# 1. bump "version" in package.json, commit it
# 2. tag and push
git tag v1.0.1
git push origin v1.0.1
```

That triggers `release.yml`, which builds all three platforms in parallel and
opens a **draft** GitHub Release with everything attached. Review it, then hit
publish.

### Why not build all three locally?

Because you can't. Each installer must be built on its own OS:

| Target | Buildable on Windows? |
|---|---|
| Windows `.exe` | Yes — `npm run dist:win` |
| macOS `.dmg` | **No.** Requires macOS (code signing and `hdiutil`) |
| Linux `.AppImage` / `.deb` | Not practically — needs Linux or Docker |

The release workflow sidesteps this with a build matrix: `windows-latest`,
`macos-latest` and `ubuntu-latest` each build their own target natively. This is
the main reason to release through CI rather than by hand.

### What gets published

| Platform | Artifacts |
|---|---|
| Windows | `Chatterlayer-<version>-Setup.exe` (installer), `Chatterlayer-<version>-portable.exe` |
| macOS | `Chatterlayer-<version>.dmg` (x64 + arm64) |
| Linux | `Chatterlayer-<version>.AppImage`, `.deb` |

Roughly 90–140 MB per file. Speech models are **not** included — the app
downloads the one the user picks on first run.

### Code signing

The builds are **unsigned**, which is fine but has consequences worth knowing
before you announce anything:

- **Windows** — SmartScreen warns on first launch (*More info* → *Run anyway*).
  Annoying but users get through it. To sign, add `CSC_LINK` and
  `CSC_KEY_PASSWORD` as repository secrets; `release.yml` already passes them
  through.
- **macOS** — considerably worse. Gatekeeper refuses to open unsigned apps and
  often claims the app is "damaged". Users must right-click → *Open*, or run
  `xattr -cr /Applications/Chatterlayer.app`. Fixing this properly needs an
  Apple Developer account ($99/yr) plus notarisation. The release notes explain
  the workaround.
- **Linux** — no signing expectations; users just `chmod +x` the AppImage.

### Local builds

```bash
npm run icon                       # regenerate build/icon.png from the logo
npm run setup -- --runtime-only    # fetch libvosk (required before packaging)
npm run pack                       # unpacked build — fast, for testing
npm run dist:win                   # real installer + portable exe
```

### What ships, and what doesn't

**Bundled:** the `libvosk` runtime. Every model needs it, it's platform-specific
so it must be chosen at build time, and it lives outside the asar archive
because `koffi.load()` needs a real file on disk. The macOS build ships a
universal (x86_64 + arm64) library, so Apple Silicon runs natively.

**Not bundled:** speech models. They're 40 MB–2.3 GB, each user needs exactly
one, and the app downloads the chosen model into the user's data directory on
first run — which also keeps them out of Program Files, where the app has no
write access.

CI must therefore run `npm run setup -- --runtime-only` before packaging.

---

## Licence

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it, stream with it, no
restrictions.

The bundled Vosk runtime is Apache 2.0. Speech models are downloaded by the user
at runtime and are not redistributed here. Discord bot usage is subject to
Discord's Terms of Service.
