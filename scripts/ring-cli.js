#!/usr/bin/env node
'use strict';
/**
 * Read-only check of the Ring connection with the plugin's own code.
 *
 *   npm run build
 *   node scripts/ring-cli.js [seconds, default 30 | --watch]
 *
 * Asks for the refresh token at a hidden prompt (or reads RING_REFRESH_TOKEN).
 * Ring replaces the token whenever it's used, so the newest one is saved to
 * RING_TOKEN_FILE (default ~/.ring-alarm-announcer-token, readable only by
 * you); use that one in the plugin config. Prints the connection, the arming
 * mode and the alarm state, nothing about the account. Never sends the alarm
 * a command. DEBUG=1 shows ring-client-api's own log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { RingAlarmSource } = require('../dist/ring');

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
  const watch = arg === '--watch';
  const seconds = watch ? 0 : Number(arg || 30);
  if (!watch && !(seconds > 0)) {
    console.error('Usage: node scripts/ring-cli.js [seconds | --watch]');
    process.exit(2);
  }

  const token = process.env.RING_REFRESH_TOKEN || await askHidden('Ring refresh token: ');
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
  const source = new RingAlarmSource({
    refreshToken: token,
    log,
    onRefreshToken: (newToken) => {
      fs.writeFileSync(tokenFile, `${newToken}\n`, { mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);
      if (!saved) {
        say(`Ring issued a new refresh token; saved it to ${tokenFile} (the one you entered no longer works)`);
      }
      saved = true;
    },
  });

  let previous;
  source.start({
    onConnection: (connected, detail) => say(connected ? 'Connected to Ring' : `Not connected${detail ? `: ${detail}` : ''}`),
    onUpdate: ({ mode, alarmState }) => {
      const line = `Alarm ${MODES[mode] || mode || 'mode unknown'}; ${alarmState ? `ALARM ACTIVE: ${alarmState}` : 'no alarm active'}`;
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

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
