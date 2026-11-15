# AGENTS.md

Guidance for AI coding agents (and humans) working on this repo. `CLAUDE.md` imports this file. Keep it current: update "Status" when work lands, and add any new real-Ring or real-Sonos quirk you discover.

## What this is

A Homebridge plugin (`homebridge-ring-alarm-911-sonos-annunciator`) that watches a **Ring Alarm** and, when it goes off, makes the home's **Sonos** speakers announce it out loud, repeating until the alarm clears, then restores whatever they were playing. It's a generic, open-source plugin for anyone running Homebridge or HOOBS. It follows the conventions of the sibling plugins [homebridge-trimlight-edge](https://github.com/guilhermechapiewski/homebridge-trimlight-edge) and [homebridge-modernforms-fan](https://github.com/guilhermechapiewski/homebridge-modernforms-fan) (their AGENTS.md files have HOOBS deployment details).

It's a **supplement** to Ring's own siren and professional monitoring, never a replacement. Ring is reached through its unofficial cloud API (the one the Ring app uses) via `ring-client-api`; Sonos is controlled locally over UPnP with our own code.

In Apple Home it shows one accessory, "Alarm Announcer", with two switches: **Alarm Announcements** (on/off, remembered across restarts) and **Test Alarm Announcement** (plays the test clip once, then turns itself off).

## Working agreements

- **Quality bar:** senior-level, robust code with tests. Verify everything (lint, unit tests, e2e once it exists, plus a real-device check when the change touches Ring or Sonos behavior) **before** asking for a review. Report what could not be verified.
- **Commits:** commit verified, green states **directly to `main`** after each chunk of work, with messages explaining what changed and why. No feature branches for now.
- **Ask first** before anything outward-facing: `git push`, `npm publish`, or anything else that leaves this machine. Also ask before:
  - **playing anything on real Sonos speakers** on the development network (people live there; a surprise alarm announcement is alarming). Read-only queries (discovery, topology, current track) are fine.
  - **sending any command to Ring** other than reading state. Never arm, disarm, sound or silence the siren, or trigger anything that could dispatch the monitoring center.
- **Never commit secrets.** The Ring refresh token is passed via the `RING_REFRESH_TOKEN` env var for scripts, never written into the repo. Don't log tokens (not even partially), and don't log Ring account details (email, location address, device serials).
- **This repo is open source and must stay generic.** Nothing may be tailored to, or describe, any particular home or test setup: no IP addresses, Sonos room names, Ring location names/IDs, device IDs, or versions/details of a specific machine, in code, docs or commit messages. Use RFC 5737 addresses (`192.0.2.x`), generic rooms (`Living Room`, `Kitchen`), and made-up IDs. Grep for leaks before committing.
- **Licensing:** ISC (`LICENSE`). `ring-client-api` (MIT) is a normal npm dependency, nothing is copied from it. If code is ever ported from anywhere, add a `NOTICE` file with its license and ship it in `files`.
- Match the surrounding code style (TypeScript, single quotes, semicolons, trailing commas; see `eslint.config.mjs`).

## Commands

```bash
npm run lint        # ESLint, zero warnings allowed (src, test, scripts)
npm run typecheck
npm test            # Jest unit tests: real local HTTP servers + real HAP objects from homebridge
npm run build       # tsc -> dist/ (CommonJS, ES2020)

# Regenerate the announcement clips (macOS only; needs a build). See "Open decisions" about licensing.
node scripts/make-clips.js [--voice <name>] [--rate 170] [--only burglar,test]

# Real Sonos checks with the plugin's own code (needs a build). All read-only except `announce`.
node scripts/sonos-cli.js discover | rooms | state [room...]     # DEBUG=1 shows raw URIs
node scripts/sonos-cli.js announce <room...> [--clip test] [--volume 30]   # PLAYS OUT LOUD: ask before running
```

Not yet built: an e2e (`test/e2e/`, real Homebridge against a mock Ring websocket + mock Sonos; `test/fakeSonos.ts` is the Sonos half) and a read-only Ring check CLI. No token script is needed: `npx -p ring-client-api ring-auth-cli` does the 2FA login. Follow the sibling repos' e2e pattern (insecure HAP HTTP API, `E2E_PLUGIN_PATH` for the packed tarball, `HOMEBRIDGE_BIN`), with the matrix Homebridge 1.8.x on Node 20.18.1 (the minimum Node) and 2.x on Node 22.

## Compatibility constraints (HOOBS)

This plugin needs **Node 20.18.1 or newer**. Older HOOBS installs (seen in the wild on Node 14–16) can't run it, unlike its siblings; the README says so.

- `engines`: Node `>=20.18.1` (undici 7, pulled in by ring-client-api, needs exactly that), Homebridge `^1.3.0 || ^2.0.0`. Verify any new HAP or Homebridge API against 1.3.
- **One runtime dependency, `ring-client-api`** (decided 2026-11-14: it's maintained and tracks Ring's protocol changes, which matters more for a safety plugin than staying dependency-free or supporting Node 14–16). It's heavy: werift, rxjs, undici, push-receiver, and `ffmpeg-for-homebridge`, whose install script downloads an ffmpeg binary. Nothing else: Sonos, the clip server and the token store use Node built-ins only.
- **ring-client-api 14 is ESM-only; this plugin is CommonJS.** Node 20.18 can't `require()` ESM, so `src/ring.ts` loads it with a real `import()` hidden from TypeScript (`new Function`). Jest can't run that path; the plugin code talks to it through structural types (`RingModule`, `RingApiLike`...), so tests use fakes.
- The compile target is ES2020 / CommonJS. Keep it (no reason to churn), and don't use newer runtime APIs than Node 20 has.

## Code map

- `src/alarm.ts`: Ring alarm states → which clip to play (`clipForAlarmState`), and the clip wording (`CLIP_TEXT`).
- `src/announcer.ts`: the announcement loop. One loop handles alarms and tests; it re-checks state between rounds, so escalation (burglar → fire), clearing, the enabled switch and shutdown all take effect immediately, even mid-clip.
- `src/audioServer.ts`: tiny HTTP server the speakers fetch clips from (`/clips/<name>.wav`, known names only, Range support).
- `src/tokenStore.ts`: persists Ring's rotated refresh token in Homebridge's storage dir.
- `src/ring.ts`: `AlarmSource` interface and `RingAlarmSource`: loads ring-client-api, watches every location with an alarm base station (`location.getSecurityPanel().onData` → `alarmInfo.state`), saves rotated tokens, and rebuilds the connection when ring-client-api gives up.
- `src/upnp.ts`: SOAP client (`soapCall`, reports `localAddress` from the socket), UPnP faults (`UpnpError`), and the minimal XML helpers.
- `src/sonosDiscovery.ts`: SSDP search for ZonePlayers, one per IPv4 interface, resent if nothing answers.
- `src/sonos.ts`: `Speakers` / `AnnouncementSession` interfaces, topology parsing, `RoomControl` (one room's SOAP calls, snapshot, `playClip`), and `SonosSpeakers` (the session: prepare, play, restore).
- `test/fakeSonos.ts`: a pretend Sonos system (one HTTP server per speaker + SSDP responder) that really fetches the clip URLs.
- `src/platform.ts`: config parsing, wiring, the accessory and its two switches.
- `audio/*.wav`: the clips (22.05 kHz 16-bit mono WAV, ~50–180 KB each), shipped in the package.

## Alarm behavior (design)

- **Announce on:** any `alarmInfo.state` except `entry-delay`. Burglar (`burglar-alarm`, `burglar-accelerated-alarm`, `user-verified-burglar-alarm`), fire (`fire-alarm`, `fire-accelerated-alarm`), CO (`co-alarm`), `user-verified-co-or-fire-alarm`, and `panic` each have a clip. Unknown future states get a generic "Alarm triggered." (a silent miss is worse) and log a warning.
- **Not during entry delay:** that's usually someone coming home to disarm.
- **Wording:** never "911 is on the way". Ring's monitoring center usually calls before dispatching, and nothing is dispatched if the alarm is cancelled or there's no monitoring plan. The burglar clip says "The monitoring center has been notified." A unit test guards this.
- **Repeat** every `repeatIntervalSeconds` (default 10, min 5), measured start to start; **stop** after `maxAnnounceMinutes` (default 15) even if the alarm is still active, so a stuck state or a lost "disarmed" can't loop forever. Quiet until that alarm clears, then re-armed.
- **Escalation** switches clips at once, without waiting out the pause.
- **Speaker failures** while an alarm is active: retried every round; the first failure is an error, later ones debug.
- **Ring disconnects:** an announcement already running continues (until clear/timeout); nothing new can be detected until it reconnects. Logged once per outage.
- **Test switch:** plays the test clip once ("This is a test of the alarm announcer. No alarm is active."); skipped during an alarm. An alarm that starts during a test takes over the same session.

## Ring (via ring-client-api 14.x)

- Token: from `ring-auth-cli`. It's base64 JSON `{ rt, hid }`: the refresh token **and the hardware id**, so the Control Center device stays the same across restarts without us storing anything else. Every refresh emits `onRefreshTokenUpdated` with a new token, which `TokenStore` persists. The token must not be shared with homebridge-ring (each rotation invalidates the other's).
- `controlCenterDisplayName` is "Homebridge Alarm Announcer".
- `api.getLocations()` fetches devices and also registers an FCM push receiver (for camera events). That's ring-client-api's normal behavior, the same as homebridge-ring; it doesn't send the alarm any command.
- `location.getSecurityPanel()` opens the realtime websocket and waits for the device list; `panel.onData` (a BehaviorSubject) emits every update; `location.onConnected` tracks the socket.
- **Reconnect gap in ring-client-api:** on close it waits 1 s and calls `createConnection()` once; if that throws before the socket opens (ticket request fails, e.g. internet down), nothing retries. `RingAlarmSource` therefore rebuilds the whole `RingApi` after `stuckDisconnectedMs` (2 min) down, and retries failed attempts with backoff (15 s doubling to 10 min). Each attempt has a 60 s timeout, since `getSecurityPanel` waits forever if the socket never opens.
- Logging: `useLogger` is global to the process. Its info goes to Homebridge debug, its errors to warnings. It logs the Ring location name at info level (debug for us); fine in the user's own log, but never paste real logs into the repo.
- Never call `setAlarmMode`, `disarm`, `arm*`, `soundSiren`, `silenceSiren`, `triggerBurglarAlarm`, `triggerFireAlarm`, `sendCommandToSecurityPanel`, or location-mode setters.
- 2FA: Ring limits codes to 10 per 10 min.

## Sonos

Design (details in the `SonosSpeakers` doc comment):

- Find rooms via `ZoneGroupTopology#GetZoneGroupState` from the speakers seen last time, else SSDP first. Skip `Invisible="1"` members (stereo-pair halves, surrounds, subs) and `IsZoneBridge="1"` (Boost/Bridge).
- Each room is handled on its own, retried every round if it failed. A room whose `CurrentURI` is `x-rincon:<coordinator>` (a group member) gets `BecomeCoordinatorOfStandaloneGroup`, then rejoins with `x-rincon:` afterwards. A room that leads a group stays in it (the group hears the announcement).
- Snapshot once per session; a snapshot that's our own clip URL (left over from a failed restore) restores to nothing.
- Volume is set per room (fixed-volume line-outs fail with 803 and are ignored). Restore puts the volume back **before** resuming, then the source: queue gets `Seek TRACK_NR` + `REL_TIME`, other URIs get their metadata back, and `Play` only if it was playing. `x-sonos-vli:` (Spotify Connect, AirPlay) can't be resumed and is left stopped.
- `playClip` polls `GetTransportInfo`: done on STOPPED after PLAYING; fails if it never started (usually the speaker can't reach the clip server) or never ends.

Real-system quirks seen so far:

- Not every speaker answers SSDP (one in a real system missed three searches in a row), but every room is listed in the topology. Always take rooms from the topology, never from SSDP alone.
- Each speaker returns the topology groups in a different order.
- A speaker with nothing loaded reports `CurrentURI` empty and STOPPED.

## Open decisions

- **Clip voice licensing.** The checked-in clips are rendered with macOS `say`. Apple's license may not allow redistributing system-voice output in a public package. Before publishing: switch to a clearly licensed voice (or record them), or ship no clips and generate them at install time.
- **Should the plugin also expose the alarm state** (e.g. a contact/occupancy sensor) to HomeKit? Probably not: homebridge-ring already does, and this plugin should stay single-purpose.

## Status (update as work lands)

- 2026-11-14: scaffold. Config, alarm-state mapping, announcement loop, clip server, token store, platform and switches are done with unit tests (57) green on Node 26 / Homebridge 1.11. Ring and Sonos clients are stubs (the plugin logs that it's not implemented). Not yet: e2e, version-matrix runs, real-device checks.
- 2026-11-14: Sonos client: SSDP discovery, topology, per-room snapshot / announce / restore, `scripts/sonos-cli.js`. Unit tests (88) green against `test/fakeSonos.ts`. Real system: `discover`, `rooms` and `state` checked read-only against a real system. **Not yet checked on real speakers:** an actual announcement and restore.
- 2026-11-14: Ring client on ring-client-api 14.3 instead of our own; engines bumped to Node >=20.18.1. Unit tests with fakes; the ESM loader works from `dist/` on Node 26 and 20.18.1, and the unit tests pass on 20.18.1 too. **Not yet:** a real read-only connection to Ring (needs a fresh token from `ring-auth-cli`).
- **Next:** a real test announcement in one room (`sonos-cli.js announce <room>`), especially restore of a grouped room and of Spotify Connect; a read-only Ring check (a `scripts/ring-cli.js` that connects and prints the panel mode/alarm state, with a token via `RING_REFRESH_TOKEN`); then the e2e and a test install on HOOBS.
