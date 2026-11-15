import {
  CONTROL_CENTER_NAME,
  ObservableLike,
  RingAlarmSource,
  RingApiLike,
  RingLocationLike,
  RingLogger,
  RingModule,
  RingPanelData,
  RingTimings,
} from '../src/ring';
import { makeLogger, waitFor } from './helpers';

/** A minimal BehaviorSubject stand-in. */
class Value<T> implements ObservableLike<T> {
  private readonly listeners = new Set<(value: T) => void>();
  constructor(public value?: T) {}
  get observers(): number {
    return this.listeners.size;
  }
  subscribe(next: (value: T) => void) {
    this.listeners.add(next);
    if (this.value !== undefined) {
      next(this.value);
    }
    return { unsubscribe: () => this.listeners.delete(next) };
  }
  next(value: T): void {
    this.value = value;
    this.listeners.forEach((listener) => listener(value));
  }
}

class FakeLocation implements RingLocationLike {
  readonly onConnected = new Value<boolean>(true);
  readonly panel = { onData: new Value<RingPanelData>({ mode: 'none' }) };
  panelError?: Error;
  /** Never resolves (the websocket never comes up). */
  hang = false;
  constructor(readonly id: string, readonly hasAlarmBaseStation = true) {}
  getSecurityPanel() {
    if (this.hang) {
      return new Promise<never>(() => undefined);
    }
    return this.panelError ? Promise.reject(this.panelError) : Promise.resolve(this.panel);
  }
}

class FakeApi implements RingApiLike {
  readonly onRefreshTokenUpdated = new Value<{ newRefreshToken: string }>();
  disconnected = false;
  constructor(readonly options: { refreshToken: string; controlCenterDisplayName: string }, private readonly ring: FakeRing) {}
  getLocations() {
    return this.ring.locationsError ? Promise.reject(this.ring.locationsError) : Promise.resolve(this.ring.locations);
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeRing implements RingModule {
  readonly apis: FakeApi[] = [];
  locations: FakeLocation[] = [new FakeLocation('loc-1')];
  locationsError?: Error;
  logger?: RingLogger;
  createApi(options: { refreshToken: string; controlCenterDisplayName: string }) {
    const api = new FakeApi(options, this);
    this.apis.push(api);
    return api;
  }
  useLogger(logger: RingLogger) {
    this.logger = logger;
  }
  get api(): FakeApi {
    return this.apis[this.apis.length - 1];
  }
}

describe('RingAlarmSource', () => {
  let ring: FakeRing;
  let log: ReturnType<typeof makeLogger>;
  let updates: Array<{ alarmState?: string; mode?: string }>;
  let connections: Array<[boolean, string | undefined]>;
  let tokens: string[];
  let source: RingAlarmSource | undefined;

  const start = (timings: Partial<RingTimings> = {}, loadModule: () => Promise<RingModule> = async () => ring) => {
    source = new RingAlarmSource({
      refreshToken: 'token-1',
      onRefreshToken: (token) => tokens.push(token),
      log,
      loadModule,
      timings: { connectTimeoutMs: 200, stuckDisconnectedMs: 100, retryMinMs: 20, retryMaxMs: 80, ...timings },
    });
    source.start({
      onUpdate: (snapshot) => updates.push(snapshot),
      onConnection: (connected, detail) => connections.push([connected, detail]),
    });
    return source;
  };
  const lastUpdate = () => updates[updates.length - 1];
  const lastConnection = () => connections[connections.length - 1];

  beforeEach(() => {
    ring = new FakeRing();
    log = makeLogger();
    updates = [];
    connections = [];
    tokens = [];
  });
  afterEach(() => source?.stop());

  it('connects with the token, names itself in Control Center and reports the panel state', async () => {
    start();
    await waitFor(() => updates.length > 0);
    expect(ring.api.options).toEqual({ refreshToken: 'token-1', controlCenterDisplayName: CONTROL_CENTER_NAME });
    expect(lastUpdate()).toEqual({ alarmState: undefined, mode: 'none' });
    expect(lastConnection()).toEqual([true, undefined]);

    ring.locations[0].panel.onData.next({ mode: 'all', alarmInfo: { state: 'burglar-alarm' } });
    expect(lastUpdate()).toEqual({ alarmState: 'burglar-alarm', mode: 'all' });
    ring.locations[0].panel.onData.next({ mode: 'none', alarmInfo: null });
    expect(lastUpdate()).toEqual({ alarmState: undefined, mode: 'none' });
  });

  it('reports the connection only when it goes up or down', async () => {
    ring.locations = [new FakeLocation('home'), new FakeLocation('cabin')];
    start();
    await waitFor(() => updates.length >= 2);
    expect(connections).toEqual([[true, undefined]]);
    ring.locations[0].onConnected.next(false);
    ring.locations[1].onConnected.next(false);
    ring.locations[0].onConnected.next(true);
    ring.locations[1].onConnected.next(true);
    ring.locations[1].onConnected.next(true);
    expect(connections).toEqual([
      [true, undefined],
      [false, 'realtime connection lost; ring-client-api is reconnecting'],
      [true, undefined],
    ]);
  });

  it('saves every new refresh token and uses the latest one when it reconnects', async () => {
    start();
    await waitFor(() => updates.length > 0);
    ring.api.onRefreshTokenUpdated.next({ newRefreshToken: 'token-2' });
    ring.api.onRefreshTokenUpdated.next({ newRefreshToken: 'token-2' });
    expect(tokens).toEqual(['token-2']);

    ring.locations[0].onConnected.next(false);
    await waitFor(() => ring.apis.length === 2);
    expect(ring.apis[0].disconnected).toBe(true);
    expect(ring.api.options.refreshToken).toBe('token-2');
  });

  it('only watches locations with an alarm, and reports the first active alarm', async () => {
    ring.locations = [new FakeLocation('cams-only', false), new FakeLocation('home'), new FakeLocation('cabin')];
    start();
    await waitFor(() => updates.length >= 2);
    expect(ring.locations[0].panel.onData.observers).toBe(0);
    ring.locations[2].panel.onData.next({ mode: 'all', alarmInfo: { state: 'fire-alarm' } });
    expect(lastUpdate().alarmState).toBe('fire-alarm');

    // Connected only while every watched location is.
    ring.locations[1].onConnected.next(false);
    expect(lastConnection()[0]).toBe(false);
    ring.locations[1].onConnected.next(true);
    expect(lastConnection()).toEqual([true, undefined]);
  });

  it('reports a login failure and retries with backoff', async () => {
    ring.locationsError = new Error('Refresh token is not valid');
    start();
    await waitFor(() => ring.apis.length >= 3);
    expect(connections[0]).toEqual([false, 'Refresh token is not valid']);
    expect(ring.apis.slice(0, -1).every((api) => api.disconnected)).toBe(true);

    ring.locationsError = undefined;
    await waitFor(() => lastConnection()[0] === true, 3000);
    expect(lastUpdate()).toEqual({ alarmState: undefined, mode: 'none' });
  });

  it('fails when the account has no Ring Alarm', async () => {
    ring.locations = [new FakeLocation('cams-only', false)];
    start();
    await waitFor(() => connections.length > 0);
    expect(connections[0]).toEqual([false, 'no Ring Alarm found on this Ring account']);
  });

  it('gives up on an attempt that never reaches the panel, and tries again', async () => {
    ring.locations[0].hang = true;
    start();
    await waitFor(() => connections.length > 0);
    expect(connections[0]).toEqual([false, "couldn't reach the Ring Alarm within 1s"]);
    ring.locations[0].hang = false;
    await waitFor(() => lastConnection()[0] === true, 3000);
  });

  it('rebuilds a connection that stays down, but leaves a short blip to ring-client-api', async () => {
    start({ stuckDisconnectedMs: 150 });
    await waitFor(() => updates.length > 0);
    ring.locations[0].onConnected.next(false);
    ring.locations[0].onConnected.next(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ring.apis).toHaveLength(1);

    ring.locations[0].panel.onData.next({ alarmInfo: { state: 'burglar-alarm' } });
    ring.locations[0].onConnected.next(false);
    await waitFor(() => ring.apis.length === 2);
    // The alarm state isn't dropped while reconnecting.
    expect(updates.filter((u) => !u.alarmState).length).toBe(1);
  });

  it("logs once and stops if ring-client-api can't be loaded", async () => {
    start({}, () => Promise.reject(new Error('Cannot find package')));
    await waitFor(() => connections.length > 0);
    expect(log.error).toHaveBeenCalledWith('Unable to load ring-client-api (needs Node 20.18.1 or newer): Cannot find package');
    expect(connections).toEqual([[false, 'ring-client-api could not be loaded']]);
  });

  it("sends ring-client-api's info to the debug log and its errors to warnings", async () => {
    start();
    await waitFor(() => !!ring.logger);
    ring.logger!.logInfo('Creating location socket.io connection', 'x');
    ring.logger!.logError(new Error('hub offline'));
    expect(log.debug).toHaveBeenCalledWith('[ring] Creating location socket.io connection x');
    expect(log.warn).toHaveBeenCalledWith('[ring] hub offline');
  });

  it('stops cleanly', async () => {
    start();
    await waitFor(() => updates.length > 0);
    source!.stop();
    expect(ring.api.disconnected).toBe(true);
    expect(ring.locations[0].panel.onData.observers).toBe(0);
    const count = updates.length;
    ring.locations[0].panel.onData.next({ alarmInfo: { state: 'panic' } });
    expect(updates).toHaveLength(count);
  });
});
