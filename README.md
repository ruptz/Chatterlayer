# Chatterlayer

Live, colour-coded captions for your Discord voice call, rendered straight into
OBS.

Built for streamers who hang out in Discord calls and want viewers to know
**who said what** — including viewers who are deaf or hard of hearing, watching
muted at work, or on a connection that's chewing up your audio.

**Free, forever, for everyone.** No paid tiers, no licence keys, no accounts, no
API keys, no per-minute billing. The speech recognition runs on your own PC. After
the one-time model download, Chatterlayer never sends anyone's audio anywhere —
it doesn't even need an internet connection to caption.

---

## Contents

**Getting started**

- [What it looks like](#what-it-looks-like)
- [Set it up](#set-it-up) — install, bot, channel, OBS
- [Which speech model should I pick?](#which-speech-model-should-i-pick)

**Using it**

- [On stream](#on-stream) — who gets captioned, names, colours, caption style
- [Consent — read this one](#consent--read-this-one)
- [The word filter](#the-word-filter)
- [How good are the captions, really?](#how-good-are-the-captions-really)
- [Troubleshooting](#troubleshooting)
- [Support the project](#support-the-project)

**[For developers](#for-developers)** — running from source, architecture,
performance numbers, releases

---

## What it looks like

Each person in your call gets their own colour and their own caption line:

```
▌ Ruptz    so if we push through the gate now
▌ Maya     no no no wait for the timer
▌ Dev      i already went in
```

- Everyone's audio is transcribed **separately**, so speakers never get mixed up
  mid-sentence.
- Colours are automatic and stable — the same friend is the same colour every
  stream, on every machine.
- You choose **exactly who gets captioned**, and can flip people in and out
  mid-call without reconnecting anything.
- The overlay background is transparent, so OBS just composites it over your
  scene.

### What you need

| | |
|---|---|
| **OS** | Windows, macOS (Intel or Apple Silicon), or Linux |
| **Disk** | ~250 MB for the app, plus the speech model you choose |
| **RAM** | ~400 MB for a 7-person call on the recommended model |
| **A Discord bot** | Free, takes two minutes — [instructions below](#3-create-your-discord-bot) |
| **OBS** | Any recent version |

You do **not** need Node.js, a compiler, Visual Studio, Python, a paid speech
API, or an account with anyone.

---

## Set it up

About ten minutes, most of which is waiting for a download.

### 1. Install Chatterlayer

Grab the latest build from the
[Releases page](https://github.com/ruptz/Chatterlayer/releases). There's a normal
installer and a portable version if you'd rather not install anything.

> **Windows will warn you on first launch.** The builds aren't code-signed (that
> costs money we're not spending), so SmartScreen shows a blue box. Click
> *More info* → *Run anyway*.
>
> **On macOS** it's a bit worse — Gatekeeper may claim the app is "damaged". It
> isn't. Right-click the app → *Open*, or run
> `xattr -cr /Applications/Chatterlayer.app` in Terminal.

### 2. Pick a speech model

On first launch Chatterlayer asks which speech model to download. Models aren't
bundled with the app because they range from 40 MB to 2.3 GB and you only need
one.

**Pick Medium unless you have a reason not to.** See
[Which speech model should I pick?](#which-speech-model-should-i-pick) if you
want the details.

### 3. Create your Discord bot

Chatterlayer needs a bot account to sit in your voice channel and listen. This is
free and takes about two minutes.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it whatever you like.
2. Open the **Bot** tab → **Add Bot**.
3. Click **Reset Token**, then **Copy**. This is what you paste into
   Chatterlayer. **Treat it like a password** — anyone who has it controls your
   bot.
4. **Leave all the Privileged Gateway Intents switched off.** Chatterlayer
   doesn't need them. If "Server Members" or "Message Content" are on, turn them
   off.
5. Open **OAuth2 → URL Generator** and tick:
   - **Scopes:** `bot`
   - **Bot Permissions:** `View Channel` and `Connect`
     *(it never talks, so it doesn't need `Speak`)*
6. Open the URL that generates, and invite the bot to your server.

> **Shortcut:** swap your own client ID into this URL and it does the same thing —
> `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1049600&scope=bot`

### 4. Paste your token and pick a channel

Open Chatterlayer and paste your **bot token** into the **Source** panel. It
signs in, and the **Server** and **Voice channel** dropdowns fill with
everywhere your bot can go. Pick one and hit **Connect**.

There's no channel ID to copy and no Developer Mode to turn on. Chatterlayer
also checks permissions while it's listing, so:

- Channels your bot **can't join** are greyed out, with the missing permission
  named when you hover. That's the single most common setup mistake, caught
  before you waste 30 seconds on a failed connect.
- **Stage channels** are marked `stage`. A bot joining a stage lands in the
  *audience* and hears nothing at all until someone invites it to speak — worth
  knowing before you wonder why captions never appear.
- A channel at its user limit is marked `full`.

The **Channels** panel then fills with everyone currently in the call. Nobody is
captioned until you switch them on.

Your token is saved encrypted using your operating system's own keystore (DPAPI
on Windows, Keychain on macOS, libsecret on Linux), so you only paste it once —
after that Chatterlayer signs in by itself at launch and the dropdowns are ready
when you open it. Your bot therefore shows as **online in Discord whenever
Chatterlayer is open**, not only while you're captioning.

> If a channel doesn't show up — a brand-new one, say — hit **Refresh**. There's
> also an **Enter a channel ID manually** fallback under the picker if you ever
> need it.

### 5. Add the overlay to OBS

1. In OBS: **Sources → + → Browser**.
2. **URL:** copy it from Chatterlayer's **Output** panel — normally
   `http://127.0.0.1:8777/overlay`.
3. **Width / Height:** match your canvas, e.g. `1920` × `1080`.
4. Tick **Shutdown source when not visible** and **Refresh browser when scene
   becomes active**.
5. Drag it where you want it. Captions render in the bottom-left with a small
   margin, so leaving the source at full canvas size and positioning it at 0,0
   usually just works.

The overlay reconnects on its own, so you can add the source before Chatterlayer
is even running, and it survives you restarting the app mid-stream.

**Nothing is exposed to the internet.** The caption server only listens on
`127.0.0.1`, which means your own machine and nothing else.

---

## Which speech model should I pick?

| Model | Download | RAM used | Startup | Good for |
|---|---|---|---|---|
| Small | 40 MB | 152 MB | instant | Big calls, older or busy PCs |
| **Medium** ⭐ | **128 MB** | **~250 MB** | ~2 s | **Almost everyone** |
| Large | 1.8 GB | ~5 GB | ~25 s | 1–3 people, accuracy first |
| Gigaspeech | 2.3 GB | 6.8 GB | ~33 s | 1–3 people, best accuracy |

**Medium is the right answer for nearly everybody.** It's clearly better than
Small and still light enough to keep up with a full call while you're gaming and
encoding at the same time.

Gigaspeech is the most accurate of the four — it was trained on conversational
audio rather than audiobooks, so it handles Discord chatter noticeably better —
but it wants ~7 GB of RAM and roughly **16× the CPU** of Small. On a busy call
that turns into captions drifting further and further behind the conversation.
Only reach for it if you're captioning one or two people and your machine has
room to spare.

You can install several models and switch between them in the **Speech model**
dropdown without re-downloading anything. They live in your user data folder,
survive app updates, and **Remove** frees the disk space when you're done with
one.

---

## On stream

### Choosing who gets captioned

The **Channels** panel lists everyone in the voice call with a toggle each.

Flip someone **on** and Chatterlayer starts transcribing them immediately. Flip
them **off** and it stops and frees the memory. You can do this live, mid-call,
as often as you like — nothing reconnects and nothing drops.

Nobody is captioned by default. That's deliberate; see
[Consent](#consent--read-this-one).

### Names and colours

**Click a name to change how it appears on captions.** Discord handles are rarely
what you want burned into your stream — `ruptz_45454` can show up as `Ruptz`. The
real handle stays visible underneath in the app so you can still tell who's who.
Clear the field to go back to their Discord name.

**Click the colour swatch** next to anyone to pick a different colour for them.

Both apply to the very next caption. No restart, no OBS refresh.

Colours are assigned automatically from each person's Discord ID, so the same
friend gets the same colour every time — and Chatterlayer guarantees **no two
people in the same call share a colour** (up to 16 people, which is where the
palette runs out).

### How the captions look

Everything in the **Output** panel applies to the live overlay instantly — no
OBS refresh needed:

| Control | What it does |
|---|---|
| **Text size** | 14–64 px |
| **Hold** | How long a caption stays on screen before fading (2–20 s) |
| **Max lines** | How many captions are visible at once (1–8) |
| **Live partial text** | Words appear as they're spoken, then get corrected when the sentence settles. Turn it off if you only want finished lines. |
| **Speaker names** | Show or hide the name in front of each caption |
| **Port** | Change it if `8777` clashes with something — remember to update the OBS URL |
| **Clear captions** | Wipes the overlay immediately. Handy panic button. |

### Watch it before your viewers do

The **Monitor** panel shows every caption as it goes out, in the same colours as
the overlay. Keep an eye on it — it's the fastest way to spot that someone's mic
is producing gibberish, or that the model is mishearing a name badly.

The **Log** panel underneath shows connection state and any errors. That's the
first place to look if something's not working.

---

## Consent — read this one

Everyone in that call is being transcribed onto your stream, permanently, in
front of your audience.

**Tell them.** Use the per-person toggles to caption only the people who've
actually agreed. In some countries and US states, recording or transcribing
someone without their consent is illegal. Chatterlayer ships with everyone
switched **off** by default specifically so that the safe option is the default
one.

---

## The word filter

Captions hit your stream the instant they're recognised — there's no chance for
you to review them first. So **racial and ethnic slurs are masked by default**,
in both speech and speaker names:

```
he called me a *****        <- speech
*****                       <- a slur in someone's Discord name
```

The masking happens before captions reach OBS *or* the in-app Monitor, so the
unmasked text never leaves the app.

**Whole words only.** Substring matching would censor perfectly ordinary
speech — and a filter that mangles normal sentences is a filter you'll switch
off, which protects nobody. Plurals are handled automatically, and multi-word
slurs are caught across adjacent words.

**Adding your own.** The **Word filter** panel takes one word or phrase per line
and saves as you type. The built-in list covers racial and ethnic slurs only —
other categories vary a lot by platform and community, so those are yours to
set.

Words that are also ordinary words in common use are deliberately left out of the
defaults, because a false positive mid-sentence is worse than useless. Add them
yourself if your community needs them.

> **This is a safety net, not a guarantee.** Speech recognition mishears things.
> It can miss a slur by transcribing it as something else, and it can invent one
> nobody said. Treat the filter as one layer of protection, not as permission to
> leave captions running unattended.

---

## How good are the captions, really?

Honest expectations, because it's better to know now than to find out on stream.

Chatterlayer uses [Vosk](https://alphacephei.com/vosk/), which is genuinely
impressive for something that runs offline on your own PC — but it is not
Whisper-large, and it is not Google or AWS or Deepgram.

**What to expect:**

- Roughly **85–92%** of words correct for a clear speaker on a decent mic in a
  quiet room. Paid cloud services get 93–97% on the same audio.
- It degrades faster than paid services with background noise, music, strong
  accents, people talking over each other, and cheap microphones.
- **No punctuation and no capitalisation.** Output is a lowercase stream of
  words.
- It struggles with proper nouns, game jargon, usernames and memes — the
  vocabulary is fixed and can't be nudged toward your community's slang.
- Numbers come out as words ("twenty twenty five").
- **Mic quality matters more than model size.** A friend on a bad headset will be
  the weak link no matter which model you run.

**Why it's still the right call here:**

- **Free and unmetered.** Cloud speech-to-text runs about $0.02–0.06 per streamed
  hour *per person*. Seven people across a five-hour stream is real money, every
  single stream. Chatterlayer costs nothing to run, ever.
- **Private.** Your friends' voices never leave your machine. No provider terms
  to read, no data retention questions, no third party in the loop.
- **Nothing to break mid-stream.** No API key to expire, no quota to hit, no
  billing failure at 2am.
- **Fast**, because there's no round-trip to a server.
- **Works offline**, including when your connection wobbles.

**Want better accuracy?** Install Gigaspeech from the model picker. It closes
much of the gap on clear speech and handles conversational Discord audio well —
at ~16× the CPU and 6.8 GB of RAM, so it's only realistic for small calls.

---

## Troubleshooting

**"Model: NOT FOUND"**
Open the model picker (**Get models**) and download one.

---

**The Server dropdown is empty, or says "Sign-in failed"**
The sign-in line under the dropdown says which it is.

- *Sign-in failed* — the token is wrong, or you reset it in the Developer Portal
  and Chatterlayer still has the old one. Paste the current token and press
  **Refresh**.
- *Signed in, but no servers* — the bot isn't in a server yet, or the only ones
  it's in have no voice channels. Re-run the invite URL from step 3.

---

**The channel I want is greyed out**
The bot is missing **View Channel** or **Connect** on that specific channel —
hover it and the dropdown says which. Channel-level permission overrides beat
server-level ones, so fix it in that channel's own permission settings, not just
on the role. Press **Refresh** afterwards.

---

**Stuck on "Linking" and never connects**
Check the **Log** panel — it reports each stage (signing in → loading model →
looking up channel → joining voice), so you can see where it stopped. Usually
it's a big model still loading: Gigaspeech takes ~33 seconds on first connect,
and the log says which model it's on.

---

**Bot joins but no captions appear**

- Have you switched at least one person **on** in the Channels panel? Nobody is
  captioned by default.
- Is that person actually transmitting? Discord shows a green ring around their
  avatar when they are.
- Is it a **stage** channel? The bot sits in the audience and receives no audio
  until you invite it to speak.
- Check the **Log** panel — recogniser errors show up there.

---

**"Used disallowed intents"**
You turned on a privileged intent the bot doesn't need. Go back to the Discord
Developer Portal and switch **Server Members** and **Message Content** off.

---

**Port 8777 already in use**
Change the port in the **Output** panel — the server rebinds straight away. Then
update the URL in your OBS browser source to match.

---

**Overlay is blank in OBS**

- Check the URL matches the one shown in the **Output** panel (the port may have
  changed).
- Make sure Chatterlayer is actually running.
- Open the same URL in a normal browser: if the overlay can't reach the app,
  you'll see a "connecting" badge, which tells you it's a connection problem
  rather than an OBS problem.

---

**Captions fall further and further behind**
You're CPU-bound. Caption fewer people, or switch to a smaller model.

---

**Someone's audio dies mid-call, and the log mentions "Failed to decrypt"**
This is a Discord end-to-end-encryption quirk, not a Chatterlayer bug.
Chatterlayer already works around it and rebuilds broken audio streams
automatically (5 attempts). If someone's captions stop for good, toggle them off
and back on. Full explanation in the
[developer section](#the-dave-encryption-problem).

---

**Audio receive stops working after a Discord update**
Receiving voice as a bot isn't an officially supported part of Discord's API,
though the library Chatterlayer uses has supported it for years. If Discord
changes something, this can break until the library catches up. Worth knowing
before you build your whole stream layout around it.

---

## Support the project

Chatterlayer is free and always will be — no tiers, no upsell, no "pro" version
holding the good features hostage.

If it's earned you a coffee, there's a **Buy me a coffee** button in the bottom
corner of the app, or [ko-fi.com/ruptz](https://ko-fi.com/ruptz). Entirely
optional, and nothing in the app changes either way.

Bug reports and feature ideas are just as welcome — open an
[issue](https://github.com/ruptz/Chatterlayer/issues).

---

## Licence

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it, stream with it, no
restrictions.

The bundled Vosk runtime is Apache 2.0. Speech models are downloaded by you at
runtime and aren't redistributed here. Discord bot usage is subject to Discord's
Terms of Service.

---
---

# For developers

Everything below this line is for people building, modifying or packaging
Chatterlayer. You don't need any of it to use the app.

**Contents**

- [Running from source](#running-from-source)
- [Scripts](#scripts)
- [How it works](#how-it-works)
- [Speaker colours](#speaker-colours)
- [The DAVE encryption problem](#the-dave-encryption-problem)
- [Performance: RAM, CPU, latency](#performance-ram-cpu-latency)
- [Project layout](#project-layout)
- [Shipping a release](#shipping-a-release)

## Running from source

Requires **Node.js 18+** (developed and tested on 22). **No compiler toolchain** —
no Visual Studio, no Python, no `node-gyp`.

```bash
git clone https://github.com/ruptz/Chatterlayer.git
cd Chatterlayer
npm install
npm run setup     # libvosk runtime + the recommended model
npm start
```

## Scripts

```bash
npm run setup -- --list          # show every available model
npm run setup -- --model=small   # pick a specific one
npm run setup -- --runtime-only  # libvosk only (what CI uses)
npm run selftest                 # audio, colour and wiring checks
npm run bench                    # RAM + CPU report for the active model
npm run test:vosk -- some.wav    # transcribe a 16 kHz mono WAV
npm run engine:headless          # run the engine without Electron, for debugging
```

Config lives in `chatterlayer-config.json` in Electron's user-data folder
(**Show config file** in the UI reveals it). The bot token inside is encrypted
via `safeStorage`, backed by the OS keystore.

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

**Why the engine is a child process.** Native/FFI modules load against plain Node
rather than Electron's ABI, a bot crash can't take the window down, and it can be
run headless (`npm run engine:headless`) for debugging.

**Why sign-in and join are separate.** The server/channel pickers are built from
`client.guilds.cache`, which only exists once the bot is logged in — so the app
signs in at launch (`signIn`) and joins a voice channel later (`start`). Two
consequences worth keeping intact:

- **Sign-in must not touch Vosk.** It used to load the model first; with the
  pickers depending on login, that would mean staring at empty dropdowns for
  ~33 seconds on Gigaspeech. Signing in first also fails a bad token in about
  two seconds rather than after a full model load.
- **Disconnect calls `leave()`, not `stop()`.** `leave()` drops the voice
  connection and the recognizers but keeps the Discord session, because logging
  out would empty the pickers every time someone disconnected. Only app shutdown
  calls `stop()`.

`signIn` is idempotent and doubles as Refresh: called with the token already in
use it just re-emits the tree, and called with a different one it tears the old
session down first. The permission verdict per channel is deliberately
**tri-state** — `permissionsFor` returns `null` when the bot's own member isn't
cached, and rendering that as "can't join" would grey out channels that work.

**Why not the `vosk` npm package.** It binds libvosk through `ffi-napi`, which has
been unmaintained since 2022 and fails to compile on Node 18+ (`ffi-napi`'s
bundled libffi errors out during assembly preprocessing). Forcing it to build
would require every user to install Visual Studio Build Tools and Python, plus an
`electron-rebuild` pass. Chatterlayer instead binds the **same official libvosk**
through [koffi](https://koffi.dev/), which ships prebuilt N-API binaries — so the
same install works on both Node and Electron with no toolchain. See
`src/engine/vosk-binding.js`.

**Why persistent audio subscriptions.** Subscribing on each `speaking start` event
races the first voice packet and clips the first word of every utterance.
Chatterlayer holds a persistent subscription per selected speaker and uses
speaking events only to flush utterance boundaries. Discord sends no packets
during silence, so idle subscriptions are free.

## Speaker colours

Colours are hashed from the Discord user ID so the same person looks the same
across sessions and machines, with zero configuration. But hashing alone isn't
enough: with a 16-colour palette, **seven random users collide about 78% of the
time** (the birthday bound — measured, not theoretical), and two speakers sharing
a colour defeats the entire point.

So Chatterlayer assigns colours across the *whole call* at once. Each person
prefers their hashed colour; when two want the same one, the assignment probes
forward through the palette. Iterating in sorted ID order keeps it deterministic —
the same group always gets the same colours. Manual overrides are reserved first
and always win.

Result: **0% duplicate colours** for calls up to 16 people, while 81% of speakers
still keep their preferred colour. Past 16 concurrent speakers the palette is
exhausted and duplicates become unavoidable.

## The DAVE encryption problem

Symptom: `Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)`
in the log, and a speaker's audio dying mid-call.

This is Discord's DAVE end-to-end encryption. `@discordjs/voice` advertises E2EE
support by default, but E2EE only tolerates unencrypted frames during brief
(~10 s) "passthrough" windows around key changes. Once that window closes, an
unencrypted packet is rejected, and after enough consecutive failures the audio
stream throws and dies. The mismatch is easy to trigger, because Discord
downgrades a call out of E2EE when a participant that can't do it joins — which
is exactly what a bot is.

**Do not "fix" this by setting `daveEncryption: false`.** It looks like the obvious
answer and it's a trap: the flag is sent as `max_dave_protocol_version: 0` in the
voice IDENTIFY payload, and Discord then never completes the handshake. The bot
still *appears* in the voice channel — that part is the main gateway — but the
voice connection never receives `SESSION_DESCRIPTION`, never reaches `Ready`, and
the join times out after 30 s with "Could not join #channel within 30s".

Chatterlayer instead leaves DAVE enabled and raises `decryptionFailureTolerance`.
That works because of how `@discordjs/voice` consumes the result (`onUdpMessage`):
an undecryptable packet returns nothing and is **skipped harmlessly**, but once
the tolerance is exceeded it *throws*, and the throw calls `stream.destroy(error)`,
killing that speaker's audio for the rest of the call. With a high tolerance, bad
packets are simply dropped.

The log shows throttled `[voice] Failed to decrypt…` lines plus the DAVE
transition messages, which is what you need to diagnose it. A stream that does die
is rebuilt automatically (5 attempts, then it asks the user to toggle the speaker
off and on).

## Performance: RAM, CPU, latency

Measured on Windows 11, Node 22.13, `vosk-model-small-en-us-0.15`. Reproduce with
`node --expose-gc scripts/bench.js 7`.

### Memory

The acoustic model is loaded **once** and shared by every recognizer, so adding a
speaker costs only a recognizer — not another copy of the model.

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
optimistic** — it uses synthetic noise, which Vosk's silence detection prunes far
more aggressively than real speech. For planning, budget **0.1–0.3× of one core
per actively-talking speaker** on a modern desktop CPU. Seven people all talking
at once is therefore roughly **1–2 cores**, and that peak is rare: Discord
transmits no packets while someone is silent, so idle speakers cost essentially
nothing.

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
Vosk finalises the utterance.

### Swapping the recognizer

If you want near-human accuracy and can spend money, the WebSocket protocol here
is simple enough to put a different recognizer behind it. The architecture doesn't
assume Vosk beyond `src/engine/vosk-worker.js`.

## Project layout

```
src/
  main/       Electron main process — window, config, server, engine supervisor
  engine/     Discord bot, Opus decode, resampling, Vosk worker + FFI binding
  renderer/   Control panel UI
  shared/     Colour hashing, model catalogue, path resolution, word filter
web/
  overlay.html    OBS browser source
scripts/
  setup-vosk.js   Downloads runtime + model
  test-vosk.js    Transcribe a WAV to verify the engine
  bench.js        RAM and CPU report
  selftest.js     Audio, colour, wiring and version-check tests
```

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

### How users find out

The running version is stamped in the top-right of the control panel. Once a
day Chatterlayer asks GitHub whether a newer release exists; if there is one,
the stamp lights amber and opens the release page when clicked.

Nothing is downloaded and nothing self-installs — see the comment at the top of
`src/main/updates.js` for why. The short version: the binaries are unsigned,
which rules out macOS auto-update entirely, and neither the portable `.exe` nor
the `.deb` can replace themselves. A link works for every build we ship.

Two things worth knowing:

- **Drafts are invisible to it.** The check reads GitHub's *latest published
  release*, which excludes drafts and prereleases. Nobody is notified until you
  actually hit publish on the draft the workflow opened.
- **It's the only request Chatterlayer makes on its own** — everything else is
  Discord and localhost. It's a visible setting for that reason: **Output →
  Check for updates**, on by default. Switched off, no request is made at all.

### Why not build all three locally?

Because you can't. Each installer must be built on its own OS:

| Target | Buildable on Windows? |
|---|---|
| Windows `.exe` | Yes — `npm run dist:win` |
| macOS `.dmg` | **No.** Requires macOS (code signing and `hdiutil`) |
| Linux `.AppImage` / `.deb` | Not practically — needs Linux or Docker |

The release workflow sidesteps this with a build matrix: `windows-latest`,
`macos-latest` and `ubuntu-latest` each build their own target natively. That's
the main reason to release through CI rather than by hand.

### What gets published

| Platform | Artifacts |
|---|---|
| Windows | `Chatterlayer-<version>-Setup.exe` (installer), `Chatterlayer-<version>-portable.exe` |
| macOS | `Chatterlayer-<version>.dmg` (x64 + arm64) |
| Linux | `Chatterlayer-<version>.AppImage`, `.deb` |

Roughly 90–140 MB per file. Speech models are **not** included — the app downloads
the one the user picks on first run.

### Code signing

The builds are **unsigned**, which is fine but has consequences worth knowing
before you announce anything:

- **Windows** — SmartScreen warns on first launch (*More info* → *Run anyway*).
  Annoying, but users get through it. To sign, add `CSC_LINK` and
  `CSC_KEY_PASSWORD` as repository secrets; `release.yml` already passes them
  through.
- **macOS** — considerably worse. Gatekeeper refuses to open unsigned apps and
  often claims the app is "damaged". Users must right-click → *Open*, or run
  `xattr -cr /Applications/Chatterlayer.app`. Fixing this properly needs an Apple
  Developer account ($99/yr) plus notarisation. The release notes explain the
  workaround.
- **Linux** — no signing expectations; users just `chmod +x` the AppImage.

### Local builds

```bash
npm run icon                       # regenerate build/icon.png from the logo
npm run setup -- --runtime-only    # fetch libvosk (required before packaging)
npm run pack                       # unpacked build — fast, for testing
npm run dist:win                   # real installer + portable exe
```

### What ships, and what doesn't

**Bundled:** the `libvosk` runtime. Every model needs it, it's platform-specific so
it must be chosen at build time, and it lives outside the asar archive because
`koffi.load()` needs a real file on disk. The macOS build ships a universal
(x86_64 + arm64) library, so Apple Silicon runs natively.

**Not bundled:** speech models. They're 40 MB–2.3 GB, each user needs exactly one,
and the app downloads the chosen model into the user's data directory on first
run — which also keeps them out of Program Files, where the app has no write
access.

CI must therefore run `npm run setup -- --runtime-only` before packaging.
