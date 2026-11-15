# homebridge-ring-alarm-911-sonos-annunciator

When your **Ring Alarm** goes off, your **Sonos** speakers announce it out loud ("Alarm triggered. Check the house and the Ring app."), repeating until the alarm is cleared, then go back to whatever they were playing. Runs on Homebridge or HOOBS.

> **Early release.** Tested against a real Ring account and real Sonos speakers (announcing, groups, restoring music), and end to end in Homebridge 1.3 to 2.5. A real alarm going off hasn't triggered it in the wild yet, so after installing, use the **Test Alarm Announcement** switch and check the log (see [After installing](#after-installing)).

> This adds to Ring's own siren and professional monitoring; it doesn't replace them. It relies on Ring's unofficial API, which can change without notice.

## Features

- Different announcements for burglary, fire, carbon monoxide and panic alarms
- Quiet during the entry delay, so walking in to disarm doesn't set it off
- Repeats until the alarm clears (or a time limit), then restores your music and volumes
- An **Alarm Announcements** switch in Apple Home to turn it off (e.g. for a party), and a **Test Alarm Announcement** switch to check it works
- Sonos is controlled on your local network; no Sonos account needed
- Talks to Ring through [ring-client-api](https://github.com/dgreif/ring), the library behind homebridge-ring

## Requirements

- Homebridge **1.3.0 or newer** (including 2.x), or HOOBS 4
- Node.js **20.18.1 or newer** (ring-client-api needs it)
- A Ring Alarm (base station) on your Ring account
- Sonos speakers on the **same network** as Homebridge

## Installation

Search for **Ring Alarm Sonos Announcer** in the Homebridge UI (or the HOOBS plugin store) and install it, or run:

```bash
npm install -g homebridge-ring-alarm-911-sonos-annunciator
```

Running it as a **child bridge** is recommended (Homebridge UI: the plugin's settings > Bridge Settings). Its Ring library is fairly large and logs on its own, and a child bridge keeps that apart from your other plugins.

Older HOOBS boxes run Node.js 14 or 16 and can't run this plugin; check with `node -v`.

## Configuration

```json
{
  "platform": "RingAlarmSonosAnnouncer",
  "name": "Ring Alarm Sonos Announcer",
  "refreshToken": "<from ring-auth-cli>",
  "rooms": ["Living Room", "Kitchen"],
  "volume": 70
}
```

| Field | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `refreshToken` | yes | | Ring refresh token, see [Getting a Ring refresh token](#getting-a-ring-refresh-token). Ring rotates it; the plugin keeps the latest one in Homebridge's storage folder. Paste a new one only if the plugin loses access. |
| `rooms` | no | every room | Sonos rooms to announce in, named as in the Sonos app. |
| `locations` | if several | the only one | Ring locations whose alarm is announced, named as in the Ring app. Required when your account has more than one location with a Ring Alarm (the plugin logs their names and waits for you to choose). |
| `announcementStyle` | no | `standard` | How the announcements are worded: `standard` ("Alarm triggered. Check the house and the Ring app."), `urgent` ("Burglar alarm! Burglar alarm!") or `deterrent` ("Warning. The alarm has been triggered and the owners have been alerted. Leave now."). Fire and carbon monoxide alarms always tell everyone to leave the house. |
| `volume` | no | `100` | Volume (1-100) while announcing. Each room goes back to its own volume afterwards. |
| `repeatIntervalSeconds` | no | `10` | From the start of one announcement to the next (minimum 5). |
| `maxAnnounceMinutes` | no | `15` | Stop announcing after this long even if the alarm is still active. |
| `speakerAddresses` | no | search the network | Only if the speakers aren't found automatically (Homebridge in Docker, speakers on another VLAN): IP addresses of one or more speakers, optionally with `:port`. One reachable speaker is enough. When set, the network isn't searched. |
| `audioPort` | no | `0` (any free port) | Port the speakers fetch the announcement from. Set it if a firewall needs a fixed port. |

### Getting a Ring refresh token

On any computer with Node.js 20 or newer, run:

```bash
npx -p ring-client-api ring-auth-cli
```

It asks for your Ring email, password and the 2FA code, then prints a refresh token. Paste it into `refreshToken`. Use a token made just for this plugin, **not the one homebridge-ring uses**: Ring replaces the token every time it's used, so two plugins sharing one keep logging each other out. The plugin shows up in the Ring app under Control Center > Authorized Client Devices as "Homebridge Alarm Announcer".

The plugin only reads the alarm state. It never arms, disarms or sounds anything.

To check the token and see your alarm locations' names without Homebridge, clone this repo and run `npm install && npm run build && node scripts/ring-cli.js`.

### After installing

1. Restart Homebridge and open its log. You should see `Watching the Ring Alarm at "<your location>"`, `Connected to Ring` and `Sonos rooms found: ...`.
2. If your Ring account has several locations with an alarm, the log lists them and asks you to set `locations`. Do that and restart.
3. In Apple Home, turn on **Test Alarm Announcement**. Your speakers should say "This is a test of the alarm announcer. No alarm is active." and go back to what they were playing. The switch turns itself off.

### Troubleshooting

- **No Sonos rooms found:** the plugin searches the local network (SSDP). In Docker or with speakers on another VLAN that may not get through; list one speaker's IP address in `speakerAddresses`.
- **"The speaker didn't play the announcement":** the speakers fetch the clips from Homebridge over HTTP. A firewall on the Homebridge machine may be blocking them; set a fixed `audioPort` and allow it.
- **Ring login fails:** generate a new token with `ring-auth-cli` (and don't share it with homebridge-ring).
- **Stack traces mentioning `ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY`:** these come from the push-notification library ring-client-api uses for camera events. They don't affect alarm announcements.

### What happens to your music

Each room is announced in on its own, so a speaker that's asleep or offline doesn't silence the others. A room that's grouped with another room is taken out of the group for the announcement and put back afterwards; a room that leads a group stays in it, so the whole group hears the announcement. Afterwards every room gets its volume back and resumes what it was playing (the queue at the same song and time, radio, TV, line-in). **Spotify Connect and AirPlay can't be resumed by the plugin**; those rooms are left stopped.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test
npm run test:e2e   # real Homebridge against a fake Ring and fake Sonos speakers
npm run build
```

See [AGENTS.md](AGENTS.md) for the design, the protocol notes and the project's working agreements.

## License

ISC. The announcement clips use a public-domain voice; see [NOTICE](NOTICE).
