import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import { AnnouncerAccessoryContext, AnnouncerPlatform, parseConfig } from '../src/platform';
import type { AlarmSourceHandlers, RingAlarmSourceOptions } from '../src/ring';
import { PLATFORM_NAME, TOKEN_STORE_FILE } from '../src/settings';
import { FakeSpeakers, makeLogger, waitFor } from './helpers';

const baseConfig: PlatformConfig = { platform: PLATFORM_NAME, refreshToken: 'config-token' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(baseConfig)).toEqual({
      refreshToken: 'config-token', rooms: [], locations: [], speakerAddresses: [], volume: 100, announcementStyle: 'standard', repeatIntervalSeconds: 10, maxAnnounceMinutes: 15, audioPort: 0,
    });
  });

  it('trims and de-duplicates rooms (ignoring case) and raises short repeat intervals to 5 s', () => {
    expect(parseConfig({ ...baseConfig, rooms: [' Kitchen ', '', 'kitchen', 'Den'], repeatIntervalSeconds: '2', volume: '55' }))
      .toMatchObject({ rooms: ['Kitchen', 'Den'], repeatIntervalSeconds: 5, volume: 55 });
    expect(parseConfig({ ...baseConfig, locations: [' Home ', 'home', 'Shop'] })).toMatchObject({ locations: ['Home', 'Shop'] });
    expect(parseConfig({ ...baseConfig, announcementStyle: 'deterrent' })).toMatchObject({ announcementStyle: 'deterrent' });
    expect(parseConfig({ ...baseConfig, speakerAddresses: ['192.0.2.10', ' 192.0.2.11:1401 ', 'sonos.local'] })).toMatchObject({
      speakerAddresses: [{ address: '192.0.2.10', port: 1400 }, { address: '192.0.2.11', port: 1401 }, { address: 'sonos.local', port: 1400 }],
    });
  });

  it('reports every problem at once', () => {
    expect(parseConfig({ platform: PLATFORM_NAME, rooms: 'Kitchen', volume: 0, maxAnnounceMinutes: 'x', audioPort: 1.5 })).toEqual([
      '"refreshToken" is required (see the README for how to get one)',
      '"rooms" must be a list of Sonos room names',
      '"volume" must be a number from 1 to 100',
      '"maxAnnounceMinutes" must be a number of minutes (1 or more)',
      '"audioPort" must be a whole number',
    ]);
    expect(parseConfig({ ...baseConfig, rooms: [7] })).toEqual(['"rooms" must be a list of Sonos room names']);
    expect(parseConfig({ ...baseConfig, locations: 'Home' })).toEqual(['"locations" must be a list of Ring location names']);
    expect(parseConfig({ ...baseConfig, announcementStyle: 'loud' })).toEqual(['"announcementStyle" must be one of "standard", "urgent", "deterrent"']);
    expect(parseConfig({ ...baseConfig, speakerAddresses: ['192.0.2.10:99999', 'http://x'] })).toEqual([
      '"speakerAddresses" entry "192.0.2.10:99999" must be an IP address or host name, optionally with :port',
      '"speakerAddresses" entry "http://x" must be an IP address or host name, optionally with :port',
    ]);
  });
});

describe('AnnouncerPlatform', () => {
  let api: HomebridgeAPI;
  let log: ReturnType<typeof makeLogger>;
  let speakers: FakeSpeakers;
  let storagePath: string;
  let audioDirectory: string;
  let source: { options?: RingAlarmSourceOptions; handlers?: AlarmSourceHandlers; stopped: boolean };
  let platform: AnnouncerPlatform | undefined;

  const create = async (config: PlatformConfig = baseConfig, cached: PlatformAccessory[] = []) => {
    platform = new AnnouncerPlatform(log, config, api, {
      createAlarmSource: (options) => {
        source.options = options;
        return { start: (handlers) => (source.handlers = handlers), stop: () => (source.stopped = true) };
      },
      createSpeakers: () => speakers,
      audioDirectory,
      storagePath,
    });
    cached.forEach((accessory) => platform!.configureAccessory(accessory));
    await platform.start();
    return platform;
  };

  const accessory = () => (api.registerPlatformAccessories as jest.Mock).mock.calls[0]?.[2][0] as
    PlatformAccessory<AnnouncerAccessoryContext>;

  const switchNamed = (target: PlatformAccessory, subtype: string) =>
    target.getServiceById(api.hap.Service.Switch, subtype)!.getCharacteristic(api.hap.Characteristic.On);

  beforeEach(() => {
    api = new HomebridgeAPI();
    jest.spyOn(api, 'registerPlatformAccessories').mockImplementation(() => undefined);
    jest.spyOn(api, 'unregisterPlatformAccessories').mockImplementation(() => undefined);
    jest.spyOn(api, 'updatePlatformAccessories').mockImplementation(() => undefined);
    log = makeLogger();
    speakers = new FakeSpeakers();
    source = { stopped: false };
    storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'announcer-storage-'));
    audioDirectory = path.join(__dirname, '..', 'audio');
  });

  afterEach(async () => {
    await platform?.stop();
    platform = undefined;
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  it('disables itself on an invalid config', async () => {
    await create({ platform: PLATFORM_NAME });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Invalid configuration, plugin disabled'));
    expect(source.handlers).toBeUndefined();
  });

  it('looks for the speakers at startup, and only warns if they are not found', async () => {
    const warmUp = jest.fn().mockRejectedValue(new Error('no Sonos speakers answered on the network'));
    Object.assign(speakers, { warmUp });
    await create();
    expect(warmUp).toHaveBeenCalledTimes(1);
    await waitFor(() => log.warn.mock.calls.length > 0);
    expect(log.warn).toHaveBeenCalledWith('Unable to find the Sonos speakers yet: no Sonos speakers answered on the network');
    expect(source.handlers).toBeDefined();
  });

  it('adds one accessory with the two switches, announcements on', async () => {
    await create();
    const added = accessory();
    expect(added.displayName).toBe('Alarm Announcer');
    expect(switchNamed(added, 'enabled').value).toBe(false); // before the first read
    expect(await switchNamed(added, 'enabled').handleGetRequest()).toBe(true);
    expect(await switchNamed(added, 'test').handleGetRequest()).toBe(false);
  });

  it('announces Ring alarms on the speakers', async () => {
    await create();
    source.handlers!.onConnection(true);
    source.handlers!.onUpdate({ alarmState: 'burglar-alarm', locations: [] });
    await waitFor(() => speakers.plays.length >= 1);
    expect(speakers.plays[0]).toMatch(/^http:\/\/192\.0\.2\.5:\d+\/clips\/burglar\.wav$/);
    source.handlers!.onUpdate({ locations: [] });
    await waitFor(() => speakers.events[speakers.events.length - 1] === 'end');
    expect(log.info).toHaveBeenCalledWith('Connected to Ring');
  });

  it('remembers the enabled switch across restarts', async () => {
    await create();
    const added = accessory();
    await switchNamed(added, 'enabled').handleSetRequest(false);
    expect(added.context.enabled).toBe(false);
    expect(api.updatePlatformAccessories).toHaveBeenCalledWith([added]);
    await platform!.stop();

    (api.registerPlatformAccessories as jest.Mock).mockClear();
    await create(baseConfig, [added]);
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    source.handlers!.onUpdate({ alarmState: 'burglar-alarm', locations: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(speakers.events).toEqual([]);
  });

  it('plays the test clip from the test switch, which then turns itself off', async () => {
    await create();
    const test = switchNamed(accessory(), 'test');
    await test.handleSetRequest(true);
    await waitFor(() => speakers.events.includes('end'));
    await waitFor(() => test.value === false);
    expect(speakers.plays[0]).toMatch(/\/clips\/test\.wav$/);
  });

  it('passes the configured Ring locations on', async () => {
    await create({ ...baseConfig, locations: ['Home'] });
    expect(source.options!.locations).toEqual(['Home']);
  });

  it('saves rotated Ring tokens and uses them on the next start', async () => {
    await create();
    expect(source.options!.refreshToken).toBe('config-token');
    source.options!.onRefreshToken('rotated-token');
    expect(fs.existsSync(path.join(storagePath, TOKEN_STORE_FILE))).toBe(true);
    await platform!.stop();

    await create();
    expect(source.options!.refreshToken).toBe('rotated-token');
  });

  it('logs connection changes once each, and unknown alarm states', async () => {
    await create();
    source.handlers!.onConnection(true);
    source.handlers!.onConnection(false, 'socket closed');
    source.handlers!.onConnection(false, 'socket closed');
    source.handlers!.onConnection(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Not connected to Ring (socket closed); alarms can\'t be announced until it reconnects');
    expect(log.info).toHaveBeenCalledWith('Reconnected to Ring');

    source.handlers!.onUpdate({ alarmState: 'flood-alarm', locations: [] });
    expect(log.warn).toHaveBeenCalledWith('Unknown Ring alarm state "flood-alarm"; using the generic announcement');
  });

  it('removes stale cached accessories and stops the Ring connection on shutdown', async () => {
    const stale = new api.platformAccessory('Old', api.hap.uuid.generate('something-else'));
    await create(baseConfig, [stale]);
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), PLATFORM_NAME, [stale]);
    await platform!.stop();
    expect(source.stopped).toBe(true);
  });
});
