import type { Logger } from 'homebridge';

/** What the plugin needs from the Ring security panel. */
export interface AlarmSnapshot {
  /** `alarmInfo.state` (e.g. "burglar-alarm"); undefined when no alarm is active. */
  alarmState?: string;
  /** Arming mode: "none" (disarmed), "some" (home) or "all" (away). */
  mode?: string;
}

export interface AlarmSourceHandlers {
  /** Called on connect and on every security-panel update. */
  onUpdate(snapshot: AlarmSnapshot): void;
  /** Connection to Ring went up or down. */
  onConnection(connected: boolean, detail?: string): void;
}

/** Live alarm state from Ring. Implementations reconnect on their own. */
export interface AlarmSource {
  start(handlers: AlarmSourceHandlers): void;
  stop(): void;
}

export interface RingAlarmSourceOptions {
  refreshToken: string;
  /** Called whenever Ring hands out a new refresh token; it must be persisted. */
  onRefreshToken(token: string): void;
  log: Logger;
  /** Loads ring-client-api; tests pass a fake. */
  loadModule?: () => Promise<RingModule>;
  timings?: Partial<RingTimings>;
}



// The parts of ring-client-api this plugin uses, typed structurally so tests
// can stand in for it (and so its ESM-only typings aren't needed here).

export interface Unsubscribable {
  unsubscribe(): void;
}

export interface ObservableLike<T> {
  subscribe(next: (value: T) => void): Unsubscribable;
}

/** The security panel's device data (a subset). */
export interface RingPanelData {
  mode?: string;
  alarmInfo?: { state?: string } | null;
}

export interface RingLocationLike {
  readonly id: string;
  readonly hasAlarmBaseStation: boolean;
  readonly onConnected: ObservableLike<boolean>;
  getSecurityPanel(): Promise<{ onData: ObservableLike<RingPanelData> }>;
}

export interface RingApiLike {
  readonly onRefreshTokenUpdated: ObservableLike<{ newRefreshToken: string }>;
  getLocations(): Promise<RingLocationLike[]>;
  disconnect(): void;
}

export interface RingLogger {
  logInfo(...message: unknown[]): void;
  logError(message: unknown): void;
}

export interface RingModule {
  createApi(options: { refreshToken: string; controlCenterDisplayName: string }): RingApiLike;
  useLogger(logger: RingLogger): void;
}

/** How the plugin shows up in the Ring app's Control Center > Authorized Client Devices. */
export const CONTROL_CENTER_NAME = 'Homebridge Alarm Announcer';

// ring-client-api is ESM-only and this plugin is CommonJS. Node 20.18 can't
// require() an ES module, and TypeScript would turn a plain import() into
// require(), so hide the import() from it.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;

export async function loadRingClientApi(): Promise<RingModule> {
  const [main, util] = await Promise.all([dynamicImport('ring-client-api'), dynamicImport('ring-client-api/util')]);
  const RingApi = main.RingApi as new (options: object) => RingApiLike;
  return {
    createApi: (options) => new RingApi(options),
    useLogger: util.useLogger as (logger: RingLogger) => void,
  };
}

export interface RingTimings {
  /** Give up on a connection attempt that hasn't reached the security panel by then. */
  connectTimeoutMs: number;
  /**
   * Rebuild the connection if it stays down this long. ring-client-api
   * reconnects by itself, but stops trying if a reconnect attempt fails
   * before the socket opens (e.g. while the internet is down).
   */
  stuckDisconnectedMs: number;
  /** First retry delay after a failed attempt; doubles up to `retryMaxMs`. */
  retryMinMs: number;
  retryMaxMs: number;
}

export const DEFAULT_RING_TIMINGS: RingTimings = {
  connectTimeoutMs: 60_000,
  stuckDisconnectedMs: 120_000,
  retryMinMs: 15_000,
  retryMaxMs: 600_000,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Live alarm state from Ring, through ring-client-api: its realtime
 * websocket delivers the security panel's `alarmInfo` the moment it changes.
 * Only reads; never sends the panel a command.
 *
 * Watches every location on the account that has a Ring Alarm base
 * station; the alarm state reported is the first active one.
 */
export class RingAlarmSource implements AlarmSource {
  private readonly timings: RingTimings;
  private handlers?: AlarmSourceHandlers;
  private module?: RingModule;
  private token: string;
  private api?: RingApiLike;
  private subscriptions: Unsubscribable[] = [];
  private states = new Map<string, RingPanelData>();
  private connected = new Map<string, boolean>();
  /** Increments on every (re)build, so callbacks from an old one are ignored. */
  private generation = 0;
  private failures = 0;
  private retryTimer?: NodeJS.Timeout;
  private stuckTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: RingAlarmSourceOptions) {
    this.timings = { ...DEFAULT_RING_TIMINGS, ...options.timings };
    this.token = options.refreshToken;
  }

  start(handlers: AlarmSourceHandlers): void {
    this.handlers = handlers;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer as NodeJS.Timeout);
    clearTimeout(this.stuckTimer as NodeJS.Timeout);
    this.teardown();
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const { log } = this.options;
    const generation = ++this.generation;
    try {
      if (!this.module) {
        try {
          this.module = await (this.options.loadModule ?? loadRingClientApi)();
        } catch (error) {
          // Not worth retrying: the package is missing or this Node is too old for it.
          log.error(`Unable to load ring-client-api (needs Node 20.18.1 or newer): ${errorMessage(error)}`);
          this.handlers?.onConnection(false, 'ring-client-api could not be loaded');
          return;
        }
        // Its own chatter goes to the debug log; its errors are worth seeing.
        this.module.useLogger({
          logInfo: (...message) => log.debug(`[ring] ${message.map(String).join(' ')}`),
          logError: (message) => log.warn(`[ring] ${errorMessage(message)}`),
        });
      }
      if (this.stopped || generation !== this.generation) {
        return;
      }
      const api = this.module.createApi({ refreshToken: this.token, controlCenterDisplayName: CONTROL_CENTER_NAME });
      this.api = api;
      this.subscriptions.push(api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
        if (newRefreshToken && newRefreshToken !== this.token) {
          this.token = newRefreshToken;
          this.options.onRefreshToken(newRefreshToken);
        }
      }));
      await this.withTimeout(this.watch(api, generation));
      this.failures = 0;
    } catch (error) {
      if (this.stopped || generation !== this.generation) {
        return;
      }
      this.failures++;
      const delay = Math.min(this.timings.retryMaxMs, this.timings.retryMinMs * 2 ** (this.failures - 1));
      log.debug(`Ring connection attempt ${this.failures} failed: ${errorMessage(error)}; retrying in ${Math.round(delay / 1000)}s`);
      this.handlers?.onConnection(false, errorMessage(error));
      this.teardown();
      this.retryTimer = setTimeout(() => void this.connect(), delay);
    }
  }

  private async watch(api: RingApiLike, generation: number): Promise<void> {
    const locations = (await api.getLocations()).filter((location) => location.hasAlarmBaseStation);
    if (!locations.length) {
      throw new Error('no Ring Alarm found on this Ring account');
    }
    const panels = await Promise.all(locations.map((location) => location.getSecurityPanel()));
    if (generation !== this.generation) {
      return;
    }
    // Locations that went away (unlikely) no longer count.
    for (const id of [...this.states.keys()]) {
      if (!locations.some((location) => location.id === id)) {
        this.states.delete(id);
      }
    }
    this.connected.clear();
    locations.forEach((location, index) => {
      this.connected.set(location.id, false);
      this.subscriptions.push(location.onConnected.subscribe((connected) => {
        if (generation === this.generation) {
          this.connected.set(location.id, connected);
          this.connectionChanged();
        }
      }));
      this.subscriptions.push(panels[index].onData.subscribe((data) => {
        if (generation === this.generation) {
          this.states.set(location.id, data ?? {});
          this.emit();
        }
      }));
    });
    this.connectionChanged();
  }

  private withTimeout(promise: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`couldn't reach the Ring Alarm within ${Math.ceil(this.timings.connectTimeoutMs / 1000)}s`)),
        this.timings.connectTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer as NodeJS.Timeout));
  }

  private emit(): void {
    let alarmState: string | undefined;
    let mode: string | undefined;
    for (const data of this.states.values()) {
      alarmState = alarmState ?? (data.alarmInfo?.state || undefined);
      mode = mode ?? data.mode;
    }
    this.handlers?.onUpdate({ alarmState, mode });
  }

  private connectionChanged(): void {
    const up = this.connected.size > 0 && [...this.connected.values()].every(Boolean);
    this.handlers?.onConnection(up, up ? undefined : 'realtime connection lost; ring-client-api is reconnecting');
    if (up) {
      clearTimeout(this.stuckTimer as NodeJS.Timeout);
      this.stuckTimer = undefined;
    } else if (!this.stuckTimer && !this.stopped) {
      this.stuckTimer = setTimeout(() => {
        this.stuckTimer = undefined;
        this.options.log.debug('Ring has been disconnected for a while; starting a new connection');
        this.teardown();
        void this.connect();
      }, this.timings.stuckDisconnectedMs);
    }
  }

  private teardown(): void {
    this.generation++;
    for (const subscription of this.subscriptions) {
      try {
        subscription.unsubscribe();
      } catch {
        // Ignore.
      }
    }
    this.subscriptions = [];
    try {
      this.api?.disconnect();
    } catch (error) {
      this.options.log.debug(`Error while disconnecting from Ring: ${errorMessage(error)}`);
    }
    this.api = undefined;
  }
}
