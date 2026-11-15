'use strict';
/**
 * End-to-end test: runs a real Homebridge process with this plugin against
 * a fake Ring (test/e2e/fakeRing.mjs, loaded instead of ring-client-api) and
 * a fake Sonos system (test/fakeSonos.ts, real HTTP servers that really
 * fetch the clips), then drives the switches through Homebridge's HAP HTTP
 * API (insecure mode) like the Home app would.
 *
 * Usage: npm run test:e2e
 * Set HOMEBRIDGE_BIN to test a different Homebridge install (e.g. v2), and
 * E2E_PLUGIN_PATH to test an unpacked `npm pack` tarball instead of the repo.
 *
 * Nothing here reaches the real Ring or real speakers: Ring is replaced by
 * the fake module, and `speakerAddresses` points at the fake speakers, which
 * turns off the network search.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_PATH = path.resolve(process.env.E2E_PLUGIN_PATH || ROOT);
const HOMEBRIDGE_BIN = process.env.HOMEBRIDGE_BIN || path.join(ROOT, 'node_modules', 'homebridge', 'bin', 'homebridge');
const FAKE_SONOS = path.join(ROOT, '.e2e-build', 'test', 'fakeSonos.js');
const PIN = '031-45-154';
const QUEUE = 'x-rincon-queue:RINCON_000000000000001400#0';

const T = { info: '3E', serial: '30', name: '23', switch: '49', on: '25' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hap(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { Authorization: PIN, 'Content-Type': 'application/hap+json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function normalizeType(type) {
  return /^[0-9A-F]{1,8}$/i.test(type) ? `${type.toUpperCase().padStart(8, '0')}-0000-1000-8000-0026BB765291` : type.toUpperCase();
}

async function waitFor(description, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await sleep(100);
  }
}

/** Waits `ms` and fails if `predicate` becomes true meanwhile. */
async function staysFalse(description, predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    assert.ok(!(await predicate()), description);
    await sleep(100);
  }
}

function startHomebridge(storageDir, pluginDir, env) {
  const child = spawn(process.execPath, [HOMEBRIDGE_BIN, '-I', '-D', '-U', storageDir, '-P', pluginDir], {
    env: { ...process.env, ...env, FORCE_COLOR: '0', DEBUG: '' },
  });
  const proc = { child, output: '' };
  const append = (chunk) => {
    proc.output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return proc;
}

async function stopHomebridge(proc) {
  if (proc.child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => proc.child.once('exit', resolve));
  proc.child.kill('SIGTERM');
  await Promise.race([exited, sleep(10000).then(() => proc.child.kill('SIGKILL'))]);
}

/** The announcer accessory's switches: { aid, enabled: {aid, iid}, test: {aid, iid} }. */
async function readSwitches(port) {
  const { body } = await hap(port, 'GET', '/accessories');
  for (const accessory of body.accessories) {
    const switches = {};
    let serial;
    for (const service of accessory.services) {
      const chars = {};
      for (const c of service.characteristics) {
        chars[normalizeType(c.type)] = { aid: accessory.aid, iid: c.iid, value: c.value };
      }
      if (normalizeType(service.type) === normalizeType(T.info)) {
        serial = chars[normalizeType(T.serial)].value;
      }
      if (normalizeType(service.type) === normalizeType(T.switch)) {
        switches[chars[normalizeType(T.name)].value] = chars[normalizeType(T.on)];
      }
    }
    if (serial === 'announcer') {
      return { aid: accessory.aid, enabled: switches['Alarm Announcements'], test: switches['Test Alarm Announcement'] };
    }
  }
  return undefined;
}

async function read(port, c) {
  const { body } = await hap(port, 'GET', `/characteristics?id=${c.aid}.${c.iid}`);
  const value = body.characteristics[0].value;
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

async function write(port, c, value) {
  const res = await hap(port, 'PUT', '/characteristics', { characteristics: [{ aid: c.aid, iid: c.iid, value }] });
  assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
  if (res.status === 207) {
    for (const result of res.body.characteristics) {
      assert.strictEqual(result.status, 0, `write failed: ${JSON.stringify(result)}`);
    }
  }
}

async function main() {
  assert.ok(fs.existsSync(path.join(PLUGIN_PATH, 'dist', 'index.js')), `No dist/index.js in ${PLUGIN_PATH}; run "npm run build" first`);
  assert.ok(fs.existsSync(FAKE_SONOS), 'No compiled fake Sonos; run "npm run test:e2e"');
  const { FakeSonos } = require(FAKE_SONOS);

  const sonos = new FakeSonos([
    { name: 'Living Room', uri: QUEUE, state: 'PLAYING', track: 3, relTime: '0:02:10', volume: 20 },
    { name: 'Kitchen', volume: 35 },
  ]);
  sonos.clipMs = 1500; // The real clips are 1.1-3.9 s; the plugin polls every 300 ms.
  await sonos.start();
  const living = sonos.player('Living Room');
  const kitchen = sonos.player('Kitchen');
  const clips = (name) => sonos.fetched.filter((f) => f.startsWith('Living Room') && f.endsWith(`/clips/${name}.wav`)).length;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-announcer-e2e-'));
  const storageDir = path.join(tmp, 'storage');
  const pluginDir = path.join(tmp, 'plugins');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(pluginDir);
  fs.symlinkSync(PLUGIN_PATH, path.join(pluginDir, 'homebridge-ring-alarm-911-sonos-annunciator'));
  const stateFile = path.join(tmp, 'ring-state.json');
  const ringLog = path.join(tmp, 'ring-log.txt');
  fs.writeFileSync(ringLog, '');
  const ring = (state) => fs.writeFileSync(stateFile, JSON.stringify({ connected: true, ...state }));
  const alarm = (alarmState, mode = 'all') => ring({ locations: [{ name: 'Home', mode, alarmState }] });
  alarm(undefined);
  const env = {
    RING_ALARM_ANNOUNCER_RING_MODULE: path.join(__dirname, 'fakeRing.mjs'),
    E2E_RING_STATE_FILE: stateFile,
    E2E_RING_LOG_FILE: ringLog,
  };

  const hapPort = 50000 + Math.floor(Math.random() * 10000);
  fs.writeFileSync(path.join(storageDir, 'config.json'), JSON.stringify({
    bridge: { name: 'Alarm Announcer E2E', username: '0E:22:33:44:55:77', port: hapPort, pin: PIN, advertiser: 'ciao', bind: ['127.0.0.1'] },
    accessories: [],
    platforms: [{
      platform: 'RingAlarmSonosAnnouncer',
      name: 'Ring Alarm Sonos Announcer',
      refreshToken: 'e2e-token',
      rooms: ['Living Room'],
      speakerAddresses: [`127.0.0.1:${kitchen.port}`],
      volume: 60,
      repeatIntervalSeconds: 5,
      maxAnnounceMinutes: 1,
    }],
  }, null, 2));

  let hb = startHomebridge(storageDir, pluginDir, env);
  const step = (msg) => console.log(`  ✓ ${msg}`);
  const logged = (text) => hb.output.includes(text);
  const restored = () => living.uri === QUEUE && living.state === 'PLAYING' && living.volume === 20;
  try {
    const switches = await waitFor('the accessory to be published', async () => {
      if (hb.child.exitCode !== null) {
        throw new Error(`Homebridge exited early:\n${hb.output}`);
      }
      return readSwitches(hapPort).catch(() => undefined);
    });
    const versionLine = (hb.output.match(/Homebridge v\d+\.\d+\.\d+[\w.-]*/) || ['Homebridge (unknown version)'])[0];
    console.log(`Running against ${versionLine} on Node ${process.version}`);
    assert.ok(switches.enabled && switches.test, 'both switches are published');
    assert.strictEqual(await read(hapPort, switches.enabled), 1);
    assert.strictEqual(await read(hapPort, switches.test), 0);
    step('plugin loaded; accessory has both switches, announcements on');

    await waitFor('Ring and Sonos to be found', () => logged('Connected to Ring') && logged('Sonos rooms found: Kitchen, Living Room'));
    assert.ok(logged('Watching the Ring Alarm at "Home"'));
    assert.ok(logged('Not talking to Ring: using the test module'));
    step('connected to (fake) Ring and found the rooms through the configured speaker address');

    await waitFor('the rotated token to be saved', () => fs.readdirSync(storageDir).some((f) => /ring/i.test(f) && !f.endsWith('.json.tmp')
      && fs.readFileSync(path.join(storageDir, f), 'utf8').includes('rotated-1')));
    assert.ok(fs.readFileSync(ringLog, 'utf8').includes('token e2e-token'));
    step('logged in with the configured token and saved the one Ring rotated it to');

    alarm('burglar-alarm');
    await waitFor('the burglar announcement', () => clips('burglar') >= 1, 10000);
    assert.ok(logged('Ring alarm: burglar-alarm; announcing on Sonos'));
    assert.strictEqual(living.volume, 60, 'announces at the configured volume');
    assert.strictEqual(kitchen.calls.filter((c) => !c.startsWith('Get')).length, 0, 'Kitchen is not a configured room');
    step('a burglar alarm is announced at the configured volume, only in the configured room');

    await waitFor('the announcement to repeat', () => clips('burglar') >= 2, 10000);
    step('it repeats every repeatIntervalSeconds');

    alarm('fire-alarm');
    await waitFor('the fire announcement', () => clips('fire') >= 1, 6000);
    step('escalation to a fire alarm switches clips as soon as the current one ends');

    alarm(undefined, 'none');
    await waitFor('the speaker to be restored', restored, 10000);
    assert.strictEqual(living.track, 3);
    assert.strictEqual(living.relTime, '0:02:10');
    assert.ok(logged('Ring alarm cleared'));
    step('when the alarm clears, the room resumes its queue at the same point and volume');

    const fetched = sonos.fetched.length;
    alarm('entry-delay');
    await staysFalse('nothing is announced during entry delay', () => sonos.fetched.length > fetched, 2000);
    alarm(undefined, 'none');
    step('entry delay is not announced');

    await write(hapPort, switches.enabled, false);
    alarm('burglar-alarm');
    await staysFalse('nothing is announced with announcements off', () => sonos.fetched.length > fetched, 2000);
    assert.ok(logged('Ring alarm: burglar-alarm (announcements are off)'));
    await write(hapPort, switches.enabled, true);
    await waitFor('the alarm to be announced once turned back on', () => sonos.fetched.length > fetched, 5000);
    alarm(undefined, 'none');
    await waitFor('the speaker to be restored', restored, 10000);
    step('the Alarm Announcements switch turns announcing off and on, even mid-alarm');

    const tests = clips('test');
    await write(hapPort, switches.test, true);
    await waitFor('the test announcement', () => clips('test') > tests, 5000);
    await waitFor('the test switch to turn itself off', async () => (await read(hapPort, switches.test)) === 0, 5000);
    await waitFor('the speaker to be restored', restored, 5000);
    step('the Test Alarm Announcement switch plays the test clip once and turns itself off');

    ring({ connected: false, locations: [{ name: 'Home', mode: 'none' }] });
    await waitFor('the disconnect to be logged', () => logged('Not connected to Ring'), 5000);
    ring({ connected: true, locations: [{ name: 'Home', mode: 'none' }] });
    await waitFor('the reconnect to be logged', () => logged('Reconnected to Ring'), 5000);
    step('losing and regaining the Ring connection is logged');

    // Restart: same accessory, switch state remembered, rotated token used.
    await write(hapPort, switches.enabled, false);
    await stopHomebridge(hb);
    hb = startHomebridge(storageDir, pluginDir, env);
    const after = await waitFor('the accessory after restart', async () => logged('Connected to Ring') && readSwitches(hapPort).catch(() => undefined));
    assert.strictEqual(after.aid, switches.aid, 'accessory id changed across restart (Home app would lose it)');
    assert.strictEqual(await read(hapPort, after.enabled), 0, 'Alarm Announcements switch was not remembered');
    assert.ok(fs.readFileSync(ringLog, 'utf8').includes('token rotated-1'), 'the saved token was not used after restart');
    step('after a restart: same accessory, switch remembered, saved Ring token used');

    const unexpected = hb.output.split('\n').filter((l) => /TypeError|ReferenceError|UnhandledPromiseRejection|characteristic warning|This plugin generated a warning|illegal value|Announcement failed|Unable to|Invalid configuration/i.test(l));
    assert.deepStrictEqual(unexpected, [], 'Homebridge logged unexpected errors/warnings');
    step('no plugin warnings or unhandled errors in the Homebridge log');

    console.log('\nE2E PASSED');
  } catch (error) {
    console.error('\nE2E FAILED:', error.message);
    console.error('--- Fake speakers ---\n' + JSON.stringify(sonos.players.map((p) => ({
      name: p.name, uri: p.uri, state: p.state, volume: p.volume, track: p.track, relTime: p.relTime, calls: p.calls.slice(-10),
    })), null, 2));
    console.error('--- Homebridge output ---\n' + hb.output);
    process.exitCode = 1;
  } finally {
    await stopHomebridge(hb);
    await sonos.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
