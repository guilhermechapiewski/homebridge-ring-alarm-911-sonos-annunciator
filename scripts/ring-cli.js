#!/usr/bin/env node
'use strict';
/**
 * Read-only check of the Ring connection with the plugin's own code.
 *
 *   npm run build
 *   node scripts/ring-cli.js [seconds, default 30 | --watch]
 *   node scripts/ring-cli.js --raw     # every realtime message's type, for debugging
 *
 * Watches every location with an alarm (the plugin needs "locations" set
 * when there are several; this lists their names).
 *
 * Token: RING_REFRESH_TOKEN if set, else the one saved by a previous run in
 * RING_TOKEN_FILE (default ~/.ring-alarm-announcer-token), else a hidden
 * prompt. Ring replaces the token whenever it's used, so the newest one is
 * always saved to RING_TOKEN_FILE (readable only by you); use that one in
 * the plugin config. Prints the connection, the arming
 * mode and the alarm state, nothing about the account. Never sends the alarm
 * a command. DEBUG=1 shows ring-client-api's own log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { RingAlarmSource, loadRingClientApi, CONTROL_CENTER_NAME } = require('../dist/ring');

const MODES = { none: 'disarmed', some: 'armed (home)', all: 'armed (away)' };
const tokenFile = process.env.RING_TOKEN_FILE || path.join(os.homedir(), '.ring-alarm-announcer-token');

const pad = (n) => String(n).padStart(2, '0');
const clock = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const say = (message) => console.log(`${clock()}  ${message}`);

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => undefined; // Don't echo the token.
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const arg = process.argv[2];
  const raw = arg === '--raw';
  const watch = arg === '--watch' || raw;
  const seconds = watch ? 0 : Number(arg || 30);
  if (!watch && !(seconds > 0)) {
    console.error('Usage: node scripts/ring-cli.js [seconds | --watch]');
    process.exit(2);
  }

  let token = process.env.RING_REFRESH_TOKEN;
  if (!token && fs.existsSync(tokenFile)) {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
    say(`Using the token saved in ${tokenFile}`);
  }
  if (!token) {
    token = await askHidden('Ring refresh token: ');
  }
  if (!token) {
    throw new Error('No token given');
  }

  const log = {
    info: (m) => say(m),
    warn: (m) => say(`[warn] ${m}`),
    error: (m) => say(`[error] ${m}`),
    debug: (m) => process.env.DEBUG && say(`[debug] ${m}`),
  };
  let saved = false;
  const saveToken = (newToken) => {
    fs.writeFileSync(tokenFile, `${newToken}\n`, { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
    if (!saved) {
      say(`Ring issued a new refresh token; saved it to ${tokenFile} (the one you entered no longer works)`);
    }
    saved = true;
  };
  if (raw) {
    await watchRaw(token, saveToken);
    return;
  }
  const source = new RingAlarmSource({
    refreshToken: token,
    log,
    onRefreshToken: saveToken,
    locations: 'all',
  });

  let previous;
  source.start({
    onConnection: (connected, detail) => say(connected ? 'Connected to Ring' : `Not connected${detail ? `: ${detail}` : ''}`),
    onUpdate: ({ locations }) => {
      const line = locations.map(({ name, mode, alarmState }) =>
        `"${name}": ${MODES[mode] || mode || 'mode unknown'}, ${alarmState ? `ALARM ACTIVE: ${alarmState}` : 'no alarm'}`).join('  |  ');
      if (line !== previous) {
        say(line);
        previous = line;
      }
    },
  });

  const finish = () => {
    source.stop();
    if (saved) {
      console.log(`\nUse the token in ${tokenFile} for the plugin's refreshToken.`);
    }
    process.exit(0);
  };
  process.on('SIGINT', finish);
  if (watch) {
    say('Watching (Ctrl-C to stop)');
  } else {
    setTimeout(finish, seconds * 1000);
  }
}

/** The fields of a device update that matter here, without names or ids. */
function summarize(item) {
  const general = (item && item.general && item.general.v2) || {};
  const device = (item && item.device && item.device.v1) || {};
  const flat = { ...general, ...device };
  const parts = [flat.deviceType || '?'];
  if ('mode' in flat) {
    parts.push(`mode=${flat.mode}`);
  }
  if ('alarmInfo' in flat) {
    parts.push(`alarmInfo=${JSON.stringify(flat.alarmInfo)}`);
  }
  if ('transitionDelayEndTimestamp' in flat) {
    parts.push('transitionDelay');
  }
  const other = Object.keys(flat).filter((k) => !['deviceType', 'mode', 'alarmInfo', 'zid', 'name', 'serialNumber', 'adapterZid', 'roomId'].includes(k));
  if (other.length) {
    parts.push(`(+${other.length} fields: ${other.slice(0, 8).join(', ')}${other.length > 8 ? ', ...' : ''})`);
  }
  return parts.join(' ');
}

/** Prints every realtime message (type only, plus mode/alarm fields) using ring-client-api directly. */
async function watchRaw(token, saveToken) {
  const ring = await loadRingClientApi();
  ring.useLogger({
    logInfo: (...m) => say(`[ring] ${m.join(' ')}`),
    logError: (m) => say(`[ring error] ${m && m.message ? m.message : m}`),
  });
  const api = ring.createApi({ refreshToken: token, controlCenterDisplayName: CONTROL_CENTER_NAME });
  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken));
  const locations = (await api.getLocations()).filter((l) => l.hasAlarmBaseStation);
  say(`${locations.length} location(s) with an alarm`);
  locations.forEach((location, index) => {
    const tag = `[location ${index + 1}]`;
    location.onConnected.subscribe((up) => say(`${tag} websocket ${up ? 'connected' : 'disconnected'}`));
    location.onMessage.subscribe((message) => {
      const bodies = Array.isArray(message.body) ? message.body : [];
      const detail = message.datatype === 'DeviceInfoDocType' ? `: ${bodies.map(summarize).join(' | ')}` : '';
      say(`${tag} ${message.msg} ${message.datatype || ''}${detail}`);
    });
  });
  for (const [index, location] of locations.entries()) {
    const panel = await location.getSecurityPanel();
    panel.onData.subscribe((data) => say(`[location ${index + 1}] panel data: mode=${data.mode} alarmInfo=${JSON.stringify(data.alarmInfo || null)}`));
  }
  say('Watching raw messages (Ctrl-C to stop). Change the mode in the Ring app now.');
  process.on('SIGINT', () => {
    api.disconnect();
    console.log(`\nThe newest token is in ${tokenFile}.`);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
