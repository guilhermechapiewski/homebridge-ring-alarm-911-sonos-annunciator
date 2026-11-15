#!/usr/bin/env node
'use strict';
/**
 * Talk to Sonos speakers with the plugin's own code, without involving Homebridge.
 *
 *   npm run build
 *   node scripts/sonos-cli.js discover               # players that answer the SSDP search
 *   node scripts/sonos-cli.js rooms                  # rooms and groups, as the plugin sees them
 *   node scripts/sonos-cli.js state [room...]        # what each room is doing (what would be restored)
 *   node scripts/sonos-cli.js announce <room...> [--clip test] [--volume 30]
 *                                                    # PLAYS OUT LOUD, then restores the rooms
 *
 * Everything except `announce` only reads from the speakers.
 */
const path = require('path');

const { CLIP_NAMES } = require('../dist/alarm');
const { AudioServer } = require('../dist/audioServer');
const { RoomControl, SonosSpeakers, DEFAULT_TIMINGS, selectRooms, sourceKind } = require('../dist/sonos');
const { discoverPlayers } = require('../dist/sonosDiscovery');

const log = Object.assign((...args) => console.log(...args), {
  info: (m) => console.log(m),
  warn: (m) => console.log(`[warn] ${m}`),
  error: (m) => console.log(`[error] ${m}`),
  debug: (m) => process.env.DEBUG && console.log(`[debug] ${m}`),
  success: (m) => console.log(m),
  log: (_level, m) => console.log(m),
});

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'discover') {
    const players = await discoverPlayers({ listenMs: 3000 });
    if (!players.length) {
      console.log('No Sonos players answered.');
    }
    for (const p of players) {
      console.log(`${p.address}:${p.port}  ${p.uuid ?? '?'}  household ${p.household ?? '?'}`);
    }
    return;
  }

  if (command === 'rooms') {
    const { rooms, localAddress } = await new SonosSpeakers({ rooms: [], log }).findRooms();
    console.log(`Reached from ${localAddress}`);
    for (const room of rooms) {
      const leader = rooms.find((r) => r.uuid === room.coordinator);
      const group = room.coordinator === room.uuid ? '' : `  (grouped with ${leader ? leader.name : room.coordinator})`;
      console.log(`${room.name}  ${room.address}:${room.port}  ${room.uuid}${group}`);
    }
    return;
  }

  if (command === 'state') {
    const { rooms } = await new SonosSpeakers({ rooms: [], log }).findRooms();
    const { selected, missing } = selectRooms(rooms, args);
    if (missing.length) {
      console.log(`Not found: ${missing.join(', ')}`);
    }
    for (const room of selected) {
      try {
        const s = await new RoomControl(room, DEFAULT_TIMINGS).snapshot();
        const where = s.uri.startsWith('x-rincon-queue:') ? `, track ${s.track} at ${s.relTime}` : '';
        console.log(`${room.name}: ${s.transportState}, ${sourceKind(s.uri)}${where}, volume ${s.volume ?? '?'}${s.mute ? ' (muted)' : ''}`);
        if (process.env.DEBUG) {
          console.log(`  uri: ${s.uri}`);
        }
      } catch (error) {
        console.log(`${room.name}: FAILED ${error.message}`);
      }
    }
    return;
  }

  if (command === 'announce') {
    const clip = option(args, '--clip', 'test');
    const volume = Number(option(args, '--volume', '30'));
    if (!CLIP_NAMES.includes(clip) || !(volume >= 1 && volume <= 100) || !args.length) {
      throw new Error(`Usage: announce <room...> [--clip ${CLIP_NAMES.join('|')}] [--volume 1-100]`);
    }
    const audio = new AudioServer({ directory: path.join(__dirname, '..', 'audio'), port: 0 });
    await audio.start();
    try {
      const session = await new SonosSpeakers({ rooms: args, log }).begin({ volume });
      const url = audio.url(clip, session.localAddress);
      console.log(`Playing ${url} in ${session.rooms.join(', ')} at volume ${volume}`);
      try {
        await session.play(url);
        console.log('Finished playing');
      } finally {
        await session.end();
        console.log('Restored');
      }
    } finally {
      await audio.stop();
    }
    return;
  }

  console.error('Usage: node scripts/sonos-cli.js discover | rooms | state [room...] | announce <room...> [--clip test] [--volume 30]');
  process.exit(2);
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
