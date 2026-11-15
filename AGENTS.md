# AGENTS.md

Guidance for AI coding agents and the humans working with them on this repo. Claude Code reads it through `CLAUDE.md` (which is just `@AGENTS.md`); Codex, Cursor and most other agents read `AGENTS.md` directly. Keep it current: update "Status" when work lands, and add any new real-Ring or real-Sonos quirk you discover.

## What this is

A Homebridge plugin, published on npm as `homebridge-ring-alarm-911-sonos-annunciator`. It watches a **Ring Alarm** and, when it goes off, makes the home's **Sonos** speakers announce it out loud, repeating until the alarm clears, then restores whatever they were playing. It's a generic, open-source plugin for anyone running Homebridge or HOOBS. It follows the conventions of the sibling plugins [homebridge-trimlight-edge](https://github.com/guilhermechapiewski/homebridge-trimlight-edge) and [homebridge-modernforms-fan](https://github.com/guilhermechapiewski/homebridge-modernforms-fan) (their AGENTS.md files have HOOBS deployment details).

It's a **supplement** to Ring's own siren and professional monitoring, never a replacement. Ring is reached through its unofficial cloud API (the one the Ring app uses) via `ring-client-api`; Sonos is controlled locally over UPnP with our own code.

In Apple Home it shows one accessory, "Alarm Announcer", with two switches: **Alarm Announcements** (on/off, remembered across restarts) and **Test Alarm Announcement** (plays the test clip once, then turns itself off).

## Working agreements

These apply to every agent and contributor. "The person you're working for" is whoever is directing you: the maintainer, or a contributor working on their own fork.

- **Quality bar:** senior-level, robust code with tests. Verify everything (lint, typecheck, unit tests, the e2e, plus a real-device check when a change touches Ring or Sonos behavior) **before** asking for a review. Report plainly what could not be verified.
- **Commits:** small, verified, green states, with messages explaining what changed and **why**. The maintainer commits directly to `main`; contributors use a fork and a pull request (one topic per PR, same checks, and say in the PR what was verified on real devices and what wasn't).
- **Pushing:** push to GitHub at regular verified checkpoints. The repo is public, so history is permanent: never force-push or rewrite pushed commits.
- **Ask the person you're working for first** before:
  - `npm publish`, or anything else that leaves the machine besides `git push` (opening issues/PRs on other projects, posting logs anywhere).
  - **playing anything on real Sonos speakers** (people live there; a surprise alarm announcement is alarming). Read-only queries (`sonos-cli.js discover|rooms|state`) are fine. For an approved test, use the test clip at about volume 50 (30 was barely audible in a real room; the plugin's default of 100 is for real alarms), read the room's state before and after, and leave the speaker as you found it.
  - **sending Ring anything but reads.** Never arm, disarm, sound or silence the siren, or trigger anything that could dispatch a monitoring center (see the forbidden calls under "Ring").
- **Secrets:** never commit, log or echo a Ring refresh token, not even partially, and never ask for one in chat. Let the person run `scripts/ring-cli.js` themselves (it reads the token at a hidden prompt or from a mode-600 file). Don't log Ring account details (email, addresses, device serials).
- **This repo is open source and must stay generic.** Nothing may be tailored to, or describe, any particular home, person or test setup, in code, docs or commit messages: no IP addresses, Sonos room names, Ring location names or IDs, device IDs, household IDs, device counts, or the versions of a specific machine. Don't write about "the owner" or "my setup"; describe findings in general terms ("a real system", "older HOOBS installs"). Use RFC 5737 addresses (`192.0.2.x`), generic rooms (`Living Room`, `Kitchen`) and made-up IDs (`RINCON_000000000000001400`). Grep for leaks before every commit, including any names you saw in real output.
- **Licensing:** ISC (`LICENSE`); third-party credits go in `NOTICE` (shipped in `files`). `ring-client-api` (MIT) is a normal npm dependency; nothing is copied from it. If code is ever ported from anywhere, credit it in `NOTICE` with its license.
- Match the surrounding code style (TypeScript, single quotes, semicolons, trailing commas; see `eslint.config.mjs`).

## Commands

```bash
npm run lint        # ESLint, zero warnings allowed (src, test, scripts)
npm run typecheck
npm test            # Jest unit tests: real local HTTP/UDP servers + real HAP objects from homebridge
npm run test:e2e    # builds, then real Homebridge vs a fake Ring module + fake Sonos (~1 min)
npm run build       # tsc -> dist/ (CommonJS, ES2020)

# Real Sonos checks with the plugin's own code (needs a build). All read-only except `announce`.
node scripts/sonos-cli.js discover | rooms | state [room...]     # DEBUG=1 shows raw URIs
node scripts/sonos-cli.js announce <room...> [--clip test] [--volume 30] [--style standard]   # PLAYS OUT LOUD: ask first

# Read-only Ring check with the plugin's own code (needs a build). Prints each alarm location's name, mode and
# alarm state; --raw prints every realtime message's type (how the multi-location issue was found).
# Token: RING_REFRESH_TOKEN, else RING_TOKEN_FILE (default ~/.ring-alarm-announcer-token, mode 600), else a hidden prompt.
node scripts/ring-cli.js [seconds, default 30 | --watch | --raw]

# Regenerate the clips with Piper (needs a build, and Python with `pip install piper-tts`; see the script's header).
node scripts/make-clips.js --python <venv>/bin/python --model <dir>/en_US-ljspeech-high.onnx [--style urgent] [--only burglar,test]
```

Ring replaces the refresh token every time it's used, and `ring-cli.js` saves the new one to its token file. So **never run `ring-cli.js` with the token a running plugin uses**: the plugin's copy stops working. Use a separate token (another `ring-auth-cli` login) for checks.

### The e2e

`test/e2e/run-e2e.js` runs a real Homebridge process and drives the switches over the insecure HAP HTTP API, like the sibling repos. It can't touch real devices:

- Ring is replaced by `test/e2e/fakeRing.mjs`, loaded through `RING_ALARM_ANNOUNCER_RING_MODULE` (test-only; the plugin logs a warning when it's set) and driven by a JSON state file.
- Sonos is `test/fakeSonos.ts` (compiled into `.e2e-build/` by `test:e2e`), reached through `speakerAddresses`, which turns off the network search.
- Fake clips "play" for 1.5 s: the plugin polls every 300 ms and has to see PLAYING, and the real clips are 1.5–5.3 s. A shorter fake clip makes playback look failed.

Run it against the packed artifact too (`npm pack`, extract, `E2E_PLUGIN_PATH=<extracted>/package node test/e2e/run-e2e.js`; catches files missing from `files`), and across the matrix: Homebridge 1.3.4 and 1.8.x on Node 20.18.1 (the minimum), 1.11.x on current Node, and 2.x on Node 22. Install each into a scratch directory (`npm install homebridge@<v>`), then `HOMEBRIDGE_BIN=<dir>/node_modules/homebridge/bin/homebridge npx -y node@<v> test/e2e/run-e2e.js`.

## Releasing

1. Bump `version` in `package.json` (semver; the lockfile follows with `npm install --package-lock-only`).
2. Verify: lint, typecheck, unit tests, the e2e on the matrix and against the packed tarball, `npm publish --dry-run` (check the file list and size).
3. Commit and push.
4. The maintainer runs `npm publish` (their npm login and 2FA). Then tag and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Never unpublish; if a release is broken, publish a fix (and `npm deprecate` the bad version if needed).

## Compatibility constraints (HOOBS)

This plugin needs **Node 20.18.1 or newer**. Older HOOBS installs (seen in the wild on Node 14–16) can't run it, unlike its siblings; the README says so.

- `engines`: Node `>=20.18.1` (undici 7, pulled in by ring-client-api, needs exactly that), Homebridge `^1.3.0 || ^2.0.0` (the e2e passes on 1.3.4). Check any new HAP or Homebridge API against 1.3.
- **One runtime dependency, `ring-client-api`** (decided 2026-11-14: it's maintained and tracks Ring's protocol changes, which matters more for a safety plugin than staying dependency-free or supporting Node 14–16). It's heavy: werift, rxjs, undici, push-receiver, and `ffmpeg-for-homebridge`, whose install script downloads an ffmpeg binary. Don't add others: Sonos, the clip server and the token store use Node built-ins only.
- **ring-client-api 14 is ESM-only; this plugin is CommonJS.** Node 20.18 can't `require()` ESM, so `src/ring.ts` loads it with a real `import()` hidden from TypeScript (`new Function`). Jest can't run that path; the plugin code talks to it through structural types (`RingModule`, `RingApiLike`...), so tests use fakes.
- The compile target is ES2020 / CommonJS. Keep it, and don't use runtime APIs newer than Node 20.

## Code map

- `src/alarm.ts`: Ring alarm states → which clip to play (`clipForAlarmState`), the announcement styles, and their wording (`CLIP_TEXT`).
- `src/announcer.ts`: the announcement loop. One loop handles alarms and tests; it re-checks state between rounds, so escalation (burglar → fire), clearing, the enabled switch and shutdown all take effect without waiting out the pause.
- `src/audioServer.ts`: tiny HTTP server the speakers fetch clips from (`/clips/<name>.wav`, known names only, Range support), serving the configured style's folder.
- `src/tokenStore.ts`: persists Ring's rotated refresh token in Homebridge's storage dir.
- `src/ring.ts`: `AlarmSource` interface and `RingAlarmSource`: loads ring-client-api, picks the alarm locations to watch (`selectLocations`: the only one, or the configured `locations`; several without a choice is a `RingSetupError`, logged once and not retried), follows `location.getSecurityPanel().onData` → `alarmInfo.state`, saves rotated tokens, and rebuilds the connection when ring-client-api gives up.
- `src/upnp.ts`: SOAP client (`soapCall`, reports `localAddress` from the socket), UPnP faults (`UpnpError`), and the minimal XML helpers.
- `src/sonosDiscovery.ts`: SSDP search for ZonePlayers, one per IPv4 interface, resent if nothing answers.
- `src/sonos.ts`: `Speakers` / `AnnouncementSession` interfaces, topology parsing, `RoomControl` (one room's SOAP calls, snapshot, `playClip`), and `SonosSpeakers` (the session: prepare, play, restore; `speakerAddresses` instead of SSDP).
- `src/platform.ts`: config parsing, wiring, the accessory and its two switches.
- `audio/<style>/<clip>.wav`: the clips, one folder per `announcementStyle`, shipped in the package.
- `test/fakeSonos.ts`: a pretend Sonos system (one HTTP server per speaker + SSDP responder) that really fetches the clip URLs. Used by the unit tests and the e2e.
- `test/e2e/`: `run-e2e.js` (the runner) and `fakeRing.mjs` (stands in for ring-client-api).
- `scripts/`: `sonos-cli.js`, `ring-cli.js` (real-device checks), `make-clips.js` + `piper-render.py` (clip rendering).

## Alarm behavior (design)

- **Announce on:** any `alarmInfo.state` except `entry-delay`. Burglar (`burglar-alarm`, `burglar-accelerated-alarm`, `user-verified-burglar-alarm`), fire (`fire-alarm`, `fire-accelerated-alarm`), CO (`co-alarm`), `user-verified-co-or-fire-alarm`, and `panic` each have a clip. Unknown future states get the generic clip (a silent miss is worse) and log a warning.
- **Not during entry delay:** that's usually someone coming home to disarm.
- **Wording:** three styles (`announcementStyle`: standard, urgent, deterrent), each with every clip; text in `CLIP_TEXT`. Never promise help that might not come: no 911, police, "monitoring center notified" or dispatch (not everyone has professional monitoring, Ring's center usually calls first, and nothing is dispatched if the alarm is cancelled). Fire and CO clips always say to leave, in every style. Unit tests guard both.
- **Repeat** every `repeatIntervalSeconds` (default 10, min 5), measured start to start; **stop** after `maxAnnounceMinutes` (default 15) even if the alarm is still active, so a stuck state or a lost "disarmed" can't loop forever. Quiet until that alarm clears, then re-armed.
- **Escalation** switches clips as soon as the current clip ends, without waiting out the pause.
- **Volume:** `volume` (default 100) while announcing; every room goes back to its own volume afterwards.
- **Speaker failures** while an alarm is active: retried every round; the first failure per room is a warning, later ones debug.
- **Ring disconnects:** an announcement already running continues (until clear/timeout); nothing new can be detected until it reconnects. Logged once per outage; a connection still coming up at startup isn't reported as lost.
- **Test switch:** plays the test clip once ("This is a test of the alarm announcer. No alarm is active."); skipped during an alarm. An alarm that starts during a test takes over the same session.

## Ring (via ring-client-api 14.x)

- Token: from `npx -p ring-client-api ring-auth-cli` (email, password, 2FA). It's base64 JSON `{ rt, hid, pnc? }`: the refresh token, **the hardware id** (so the Control Center device stays the same across restarts) and push credentials. Every refresh emits `onRefreshTokenUpdated` with a new token, which `TokenStore` persists. A token must not be shared between two clients (homebridge-ring, `ring-cli.js`, another install): each rotation invalidates the other's copy.
- `controlCenterDisplayName` is "Homebridge Alarm Announcer".
- Accounts can have several locations with an alarm (a home and a business, say), but the speakers are in one place, so the plugin never guesses: with more than one, `locations` is required. The snapshot carries each watched location's mode and alarm state; `alarmState` is the first active one.
- `api.getLocations()` fetches devices and also registers an FCM push receiver (for camera events). That's ring-client-api's normal behavior, the same as homebridge-ring; it sends the alarm no command.
- `location.getSecurityPanel()` opens the realtime websocket and waits for the device list; `panel.onData` (a BehaviorSubject) emits every update; `location.onConnected` tracks the socket. Mode changes were seen arriving within a second as `DataUpdate DeviceInfoDocType` for the `security-panel`; `alarmInfo` is expected on the same path (as homebridge-ring relies on) but hasn't been observed here yet.
- **Reconnect gap in ring-client-api:** on close it waits 1 s and calls `createConnection()` once; if that throws before the socket opens (ticket request fails, e.g. internet down), nothing retries. `RingAlarmSource` therefore rebuilds the whole `RingApi` after `stuckDisconnectedMs` (2 min) down, and retries failed attempts with backoff (15 s doubling to 10 min). Each attempt has a 60 s timeout, since `getSecurityPanel` waits forever if the socket never opens.
- Logging: `useLogger` is global to the process. Its info goes to Homebridge debug, its errors to warnings. It logs the Ring location name at info level (debug for us); fine in the user's own log, but never paste real logs into the repo.
- Never call `setAlarmMode`, `disarm`, `arm*`, `soundSiren`, `silenceSiren`, `triggerBurglarAlarm`, `triggerFireAlarm`, `sendCommandToSecurityPanel`, or location-mode setters.
- 2FA: Ring limits codes to 10 per 10 min.

## Sonos

Design (details in the `SonosSpeakers` doc comment):

- Find rooms via `ZoneGroupTopology#GetZoneGroupState` from the speakers seen last time, else `speakerAddresses` if configured (then the network is never searched), else SSDP. Skip `Invisible="1"` members (stereo-pair halves, surrounds, subs) and `IsZoneBridge="1"` (Boost/Bridge).
- Each room is handled on its own, retried every round if it failed. A room whose `CurrentURI` is `x-rincon:<coordinator>` (a group member) gets `BecomeCoordinatorOfStandaloneGroup`, then rejoins with `x-rincon:` afterwards. A room that leads a group stays in it (the group hears the announcement).
- Snapshot once per session; a snapshot that's our own clip URL (left over from a failed restore) restores to nothing.
- Volume is set per room (fixed-volume line-outs fail with 803 and are ignored). Restore puts the volume back **before** resuming, then the source: queue gets `Seek TRACK_NR` + `REL_TIME`, other URIs get their metadata back, and `Play` only if it was playing. `x-sonos-vli:` (Spotify Connect, AirPlay) can't be resumed and is left stopped. When there's nothing to resume, the room's own queue (`x-rincon-queue:<uuid>#0`) is selected, not played, so the clip isn't left loaded (Play in the Sonos app would fail once the clip server is gone).
- `playClip` polls `GetTransportInfo` every 300 ms: done on STOPPED after PLAYING; fails if it never started (usually the speaker can't reach the clip server) or never ends.

Real-system quirks seen so far:

- Not every speaker answers SSDP (one in a real system missed three searches in a row), but every room is listed in the topology. Always take rooms from the topology, never from SSDP alone.
- Each speaker returns the topology groups in a different order.
- A speaker with nothing loaded reports `CurrentURI` empty and STOPPED.
- Music started from the Spotify app is Spotify Connect (`x-sonos-vli:`), not resumable; the same playlist started from the Sonos app plays from the queue and resumes fine.

## Announcement audio

- Clips are rendered ahead of time and shipped; nothing is synthesized at runtime (that would need Piper and its models on the Homebridge machine). That's why the wording is a choice of styles rather than free text.
- Voice: Piper with `en_US-ljspeech-high`, trained from scratch on the public-domain LJ Speech dataset (credited in `NOTICE`). Many Piper voices are **not** redistributable: lessac needs a signed research licence, ryan and hfc_* are CC BY-NC-SA, and several voices are fine-tuned from lessac. Before switching voices, check the voice's MODEL_CARD on huggingface.co/rhasspy/piper-voices **and** what it was fine-tuned from, then update `NOTICE`. Public-domain/CC0 alternatives: norman, kristin, john (LibriVox), joe (CC0).
- Piper (GPL-3.0) is a development tool here; none of it ships.
- Format: 22.05 kHz 16-bit mono WAV, 0.4 s silent lead-in (speakers can swallow the first moment while their amplifier wakes), peak-normalized to −1 dBFS; 1.5–5.3 s long. `scripts/piper-render.py` does this.
- Piper quirk: espeak-ng truncates long data paths, so `piper-render.py` runs from Piper's package folder with a relative `espeak-ng-data`. On macOS's system Python 3.9 the `piper` CLI fails with "phontab: No such file" for the same reason.

## Known issues

- **Push-notification noise:** on alarm events, `@eneris/push-receiver` (camera/doorbell pushes only) can fail to decrypt with `ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY` and prints the stack with `console.error` itself (its emitter catches listener errors). Harmless to alarm detection, which arrives on the websocket. Root cause not found; the README's troubleshooting section mentions it.
- Spotify Connect and AirPlay can't be resumed after an announcement (documented in the README).
- A real alarm going off hasn't been observed end to end yet (mode changes have, live); see Status.

## Open decisions

- **Should the plugin also expose the alarm state** (e.g. a contact/occupancy sensor) to HomeKit? Probably not: homebridge-ring already does, and this plugin should stay single-purpose.

## Status (update as work lands)

- 2026-11-14: **0.1.0 published** to npm (tag `v0.1.0`). Built in one go: scaffold; Sonos client (SSDP, topology, per-room snapshot / announce / restore); Ring client on ring-client-api 14.3 (engines Node >=20.18.1); multi-location support (`locations`); `speakerAddresses`; Piper clips in three styles; e2e.
- Verified on real devices: Sonos discovery and state; announcements and restores for a standalone room, a group member (left and rejoined; the leader kept playing) and a group leader playing a queue (resumed at the same point). Ring: real read-only connection, token rotation saved, live mode changes on multiple locations.
- Verified locally (there is no CI yet): unit tests (111); e2e (13 scenarios) on Homebridge 1.3.4 and 1.8.5 / Node 20.18.1, 1.11.4 / Node 26, 2.5.0 / Node 22, and against the packed tarball.
- **Not yet verified:** a real alarm (`alarmInfo.state` set) triggering an announcement in a real install; installation from npm on a real HOOBS box.
- **Next:** first install on HOOBS from npm; record what Ring sends when a real alarm goes off (`ring-cli.js --raw` with a separate token). Never set one off deliberately without the person's explicit go-ahead and their monitoring provider warned first.
