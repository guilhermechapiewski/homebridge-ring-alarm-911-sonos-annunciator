import path from 'path';

import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { isKnownAlarmState } from './alarm';
import { Announcer } from './announcer';
import { AudioServer } from './audioServer';
import { AlarmSource, RingAlarmSource, RingAlarmSourceOptions } from './ring';
import { SonosSpeakers, Speakers } from './sonos';
import {
  DEFAULT_MAX_ANNOUNCE_MINUTES,
  DEFAULT_REPEAT_INTERVAL_SECONDS,
  DEFAULT_VOLUME,
  MIN_REPEAT_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  TOKEN_STORE_FILE,
} from './settings';
import { TokenStore } from './tokenStore';

export interface AnnouncerPlatformConfig {
  refreshToken: string;
  /** Sonos room names; empty means every room. */
  rooms: string[];
  /** Ring location names to watch; empty means the only one (required if there are several). */
  locations: string[];
  volume: number;
  repeatIntervalSeconds: number;
  maxAnnounceMinutes: number;
  /** Port for the clip server; 0 picks a free one. */
  audioPort: number;
}

export interface AnnouncerAccessoryContext {
  /** The "Alarm Announcements" switch; survives restarts. */
  enabled?: boolean;
}

export interface PlatformDeps {
  createAlarmSource?: (options: RingAlarmSourceOptions) => AlarmSource;
  createSpeakers?: (rooms: string[]) => Speakers;
  /** Where the clips are; defaults to the package's `audio` directory. */
  audioDirectory?: string;
  /** Defaults to Homebridge's storage path. */
  storagePath?: string;
}

function readNumber(
  config: PlatformConfig, key: string, fallback: number, min: number, max: number, errors: string[], description: string,
): number {
  const raw = config[key];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`"${key}" must be ${description}`);
    return fallback;
  }
  return value;
}

/** A list of names: trimmed, blanks dropped, de-duplicated ignoring case. */
function readNames(config: PlatformConfig, key: string, what: string, errors: string[]): string[] {
  const value = config[key];
  const names: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') {
        errors.push(`"${key}" must be a list of ${what}`);
        return names;
      }
      const name = entry.trim();
      if (name && !names.some((known) => known.toLowerCase() === name.toLowerCase())) {
        names.push(name);
      }
    }
  } else if (value !== undefined && value !== null && value !== '') {
    errors.push(`"${key}" must be a list of ${what}`);
  }
  return names;
}

/** Validates the raw Homebridge config, returning a list of problems if invalid. */
export function parseConfig(config: PlatformConfig): AnnouncerPlatformConfig | string[] {
  const errors: string[] = [];

  const refreshToken = typeof config.refreshToken === 'string' ? config.refreshToken.trim() : '';
  if (!refreshToken) {
    errors.push('"refreshToken" is required (see the README for how to get one)');
  }

  const rooms = readNames(config, 'rooms', 'Sonos room names', errors);
  const locations = readNames(config, 'locations', 'Ring location names', errors);

  const volume = Math.round(readNumber(config, 'volume', DEFAULT_VOLUME, 1, 100, errors, 'a number from 1 to 100'));
  const repeatIntervalSeconds = Math.max(MIN_REPEAT_INTERVAL_SECONDS, readNumber(
    config, 'repeatIntervalSeconds', DEFAULT_REPEAT_INTERVAL_SECONDS, 0, 3600, errors, 'a number of seconds'));
  const maxAnnounceMinutes = readNumber(
    config, 'maxAnnounceMinutes', DEFAULT_MAX_ANNOUNCE_MINUTES, 1, 24 * 60, errors, 'a number of minutes (1 or more)');
  const audioPort = readNumber(config, 'audioPort', 0, 0, 65535, errors, 'a port number (0 picks a free one)');
  if (!Number.isInteger(audioPort)) {
    errors.push('"audioPort" must be a whole number');
  }

  return errors.length ? errors : { refreshToken, rooms, locations, volume, repeatIntervalSeconds, maxAnnounceMinutes, audioPort };
}

/**
 * Watches the Ring Alarm and announces alarms on Sonos. Exposes one
 * accessory with two switches: "Alarm Announcements" (on/off, remembered)
 * and "Test Alarm Announcement" (plays the test clip, then turns itself off).
 */
export class AnnouncerPlatform implements DynamicPlatformPlugin {
  private readonly cached: PlatformAccessory<AnnouncerAccessoryContext>[] = [];
  private readonly settings?: AnnouncerPlatformConfig;
  private readonly deps: PlatformDeps;
  private announcer?: Announcer;
  private audioServer?: AudioServer;
  private alarmSource?: AlarmSource;
  private testService?: Service;
  private connected?: boolean;
  private stopped = false;

  constructor(
    readonly log: Logger,
    config: PlatformConfig,
    readonly api: API,
    deps: PlatformDeps = {},
  ) {
    this.deps = deps;
    const parsed = parseConfig(config);
    if (Array.isArray(parsed)) {
      this.log.error(`Invalid configuration, plugin disabled: ${parsed.join('; ')}`);
      return;
    }
    this.settings = parsed;
    if (Number(config.repeatIntervalSeconds) > 0 && Number(config.repeatIntervalSeconds) < MIN_REPEAT_INTERVAL_SECONDS) {
      this.log.warn(`repeatIntervalSeconds ${config.repeatIntervalSeconds} is below the minimum; using ${MIN_REPEAT_INTERVAL_SECONDS}`);
    }
    this.api.on('didFinishLaunching', () => void this.start());
    this.api.on('shutdown', () => void this.stop());
  }

  /** Called by Homebridge for each accessory restored from its cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory as PlatformAccessory<AnnouncerAccessoryContext>);
  }

  async start(): Promise<void> {
    const settings = this.settings;
    if (!settings || this.stopped) {
      return;
    }

    const audioServer = new AudioServer({
      directory: this.deps.audioDirectory ?? path.join(__dirname, '..', 'audio'),
      port: settings.audioPort,
    });
    const missing = audioServer.missingClips();
    if (missing.length) {
      this.log.error(`Announcement clips missing from the package: ${missing.join(', ')}`);
    }
    try {
      const port = await audioServer.start();
      this.log.debug(`Serving announcement clips on port ${port}`);
    } catch (error) {
      this.log.error(`Unable to start the clip server on port ${settings.audioPort}, plugin disabled: ${(error as Error).message}`);
      return;
    }
    this.audioServer = audioServer;

    const speakers = (this.deps.createSpeakers ?? ((rooms) => new SonosSpeakers({ rooms, log: this.log })))(settings.rooms);
    speakers.warmUp?.().catch((error: Error) => this.log.warn(`Unable to find the Sonos speakers yet: ${error.message}`));
    this.announcer = new Announcer({
      speakers,
      clipUrl: (clip, address) => audioServer.url(clip, address),
      log: this.log,
      volume: settings.volume,
      repeatIntervalMs: settings.repeatIntervalSeconds * 1000,
      maxDurationMs: settings.maxAnnounceMinutes * 60_000,
    });
    this.setUpAccessory();
    if (this.stopped) {
      return;
    }

    const storagePath = this.deps.storagePath ?? this.api.user.storagePath();
    const tokens = new TokenStore(path.join(storagePath, TOKEN_STORE_FILE));
    const configToken = settings.refreshToken;
    this.alarmSource = (this.deps.createAlarmSource ?? ((options) => new RingAlarmSource(options)))({
      refreshToken: tokens.current(configToken),
      onRefreshToken: (token) => {
        try {
          tokens.save(configToken, token);
        } catch (error) {
          this.log.error(`Unable to save the new Ring refresh token; the plugin may lose access after a restart: ${(error as Error).message}`);
        }
      },
      log: this.log,
      locations: settings.locations,
    });
    this.alarmSource.start({
      onUpdate: (snapshot) => {
        if (snapshot.alarmState && !isKnownAlarmState(snapshot.alarmState)) {
          this.log.warn(`Unknown Ring alarm state "${snapshot.alarmState}"; using the generic announcement`);
        }
        this.announcer?.update(snapshot.alarmState);
      },
      onConnection: (connected, detail) => this.onConnection(connected, detail),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.alarmSource?.stop();
    await this.announcer?.dispose();
    await this.audioServer?.stop();
  }

  private onConnection(connected: boolean, detail?: string): void {
    if (connected === this.connected) {
      return;
    }
    const first = this.connected === undefined;
    this.connected = connected;
    if (connected) {
      this.log.info(first ? 'Connected to Ring' : 'Reconnected to Ring');
    } else {
      // An alarm already being announced keeps going (until it clears or times out).
      this.log.warn(`Not connected to Ring${detail ? ` (${detail})` : ''}; alarms can't be announced until it reconnects`);
    }
  }

  private setUpAccessory(): void {
    const { Service: S, Characteristic: C, uuid } = this.api.hap;
    const id = uuid.generate(`${PLUGIN_NAME}:announcer`);
    const stale = this.cached.filter((accessory) => accessory.UUID !== id);
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
    let accessory = this.cached.find((cached) => cached.UUID === id);
    if (!accessory) {
      accessory = new this.api.platformAccessory<AnnouncerAccessoryContext>('Alarm Announcer', id, this.api.hap.Categories.SWITCH);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    const announcer = this.announcer!;
    announcer.setEnabled(accessory.context.enabled !== false);

    (accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation))
      .setCharacteristic(C.Manufacturer, 'Homebridge')
      .setCharacteristic(C.Model, 'Ring Alarm Sonos Announcer')
      .setCharacteristic(C.SerialNumber, 'announcer');

    const enabledService = this.ensureSwitch(accessory, 'Alarm Announcements', 'enabled');
    enabledService.getCharacteristic(C.On)
      .onGet(() => announcer.isEnabled)
      .onSet((value) => {
        const enabled = value === true || value === 1;
        announcer.setEnabled(enabled);
        accessory!.context.enabled = enabled;
        this.api.updatePlatformAccessories([accessory!]);
      });
    enabledService.setPrimaryService(true);

    this.testService = this.ensureSwitch(accessory, 'Test Alarm Announcement', 'test');
    this.testService.getCharacteristic(C.On)
      .onGet(() => false)
      .onSet((value) => {
        if (value === true || value === 1) {
          // Don't hold up HomeKit for the whole clip; flip back when it's done.
          void announcer.test().finally(() => this.testService?.updateCharacteristic(C.On, false));
        }
      });
  }

  private ensureSwitch(accessory: PlatformAccessory, name: string, subtype: string): Service {
    const { Service: S, Characteristic: C } = this.api.hap;
    const existing = accessory.getServiceById(S.Switch, subtype);
    if (existing) {
      return existing;
    }
    const service = accessory.addService(S.Switch, name, subtype);
    service.setCharacteristic(C.Name, name);
    return service;
  }
}
