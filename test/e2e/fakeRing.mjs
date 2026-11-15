/**
 * Stands in for ring-client-api inside the Homebridge process during the
 * end-to-end test (loaded through RING_ALARM_ANNOUNCER_RING_MODULE).
 *
 * The test drives it through a JSON file (E2E_RING_STATE_FILE):
 *   { "connected": true, "locations": [{ "name": "Home", "mode": "all", "alarmState": "burglar-alarm" }] }
 * and reads what it did from a log file (E2E_RING_LOG_FILE), one line per
 * event: "token <refresh token used>".
 *
 * Like the real library: ESM, BehaviorSubject-style observables, and a new
 * refresh token issued after every login.
 */
import fs from 'node:fs';

const stateFile = process.env.E2E_RING_STATE_FILE;
const logFile = process.env.E2E_RING_LOG_FILE;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { connected: true, locations: [] };
  }
}

function record(line) {
  fs.appendFileSync(logFile, `${line}\n`);
}

class Value {
  constructor(value) {
    this.value = value;
    this.listeners = new Set();
  }

  subscribe(next) {
    this.listeners.add(next);
    if (this.value !== undefined) {
      next(this.value);
    }
    return { unsubscribe: () => this.listeners.delete(next) };
  }

  next(value) {
    this.value = value;
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

let logins = 0;

class FakeLocation {
  constructor(index, initial) {
    this.id = `location-${index}`;
    this.name = initial.name;
    this.hasAlarmBaseStation = initial.alarm !== false;
    this.onConnected = new Value(false);
    this.panel = { onData: new Value(FakeLocation.panelData(initial)) };
  }

  static panelData(location) {
    return { mode: location.mode || 'none', alarmInfo: location.alarmState ? { state: location.alarmState } : null };
  }

  getSecurityPanel() {
    return Promise.resolve(this.panel);
  }
}

class FakeApi {
  constructor(options) {
    this.options = options;
    this.onRefreshTokenUpdated = new Value();
    this.locations = readState().locations.map((location, index) => new FakeLocation(index, location));
    this.last = '';
    record(`token ${options.refreshToken}`);
    this.timer = setInterval(() => this.poll(), 100);
    // Ring answers a login with a new refresh token.
    setTimeout(() => this.onRefreshTokenUpdated.next({ newRefreshToken: `rotated-${++logins}` }), 50);
  }

  poll() {
    const text = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
    if (text === this.last) {
      return;
    }
    this.last = text;
    const state = readState();
    this.locations.forEach((location, index) => {
      if (location.onConnected.value !== (state.connected !== false)) {
        location.onConnected.next(state.connected !== false);
      }
      const wanted = state.locations[index];
      if (wanted) {
        const data = FakeLocation.panelData(wanted);
        if (JSON.stringify(data) !== JSON.stringify(location.panel.onData.value)) {
          location.panel.onData.next(data);
        }
      }
    });
  }

  getLocations() {
    return Promise.resolve(this.locations);
  }

  disconnect() {
    clearInterval(this.timer);
  }
}

export function createApi(options) {
  return new FakeApi(options);
}

export function useLogger() {
  // The real library's log goes here; the fake has nothing to say.
}
