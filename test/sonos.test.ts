import path from 'path';

import { AudioServer } from '../src/audioServer';
import { SonosSpeakers, parseZoneGroupState, selectRooms, sourceKind } from '../src/sonos';
import { FakePlayerInit, FakeSonos } from './fakeSonos';
import { makeLogger } from './helpers';

const QUEUE = 'x-rincon-queue:RINCON_000000000000001400#0';
const RADIO = 'x-sonosapi-stream:s12345?sid=254&flags=8224&sn=0';

describe('parseZoneGroupState', () => {
  it('lists visible rooms with their address and group coordinator', () => {
    const xml = '<ZoneGroupState><ZoneGroups>'
      + '<ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1">'
      + '<ZoneGroupMember UUID="RINCON_A" Location="http://192.0.2.10:1400/xml/device_description.xml" ZoneName="Living Room">'
      + '<Satellite UUID="RINCON_S" Location="http://192.0.2.13:1400/xml/device_description.xml" ZoneName="Living Room" Invisible="1"/>'
      + '</ZoneGroupMember>'
      + '<ZoneGroupMember UUID="RINCON_B" Location="http://192.0.2.11:1400/xml/device_description.xml" ZoneName="Kitchen"/>'
      + '<ZoneGroupMember UUID="RINCON_B2" Location="http://192.0.2.12:1400/xml/device_description.xml" ZoneName="Kitchen" Invisible="1"/>'
      + '</ZoneGroup>'
      + '<ZoneGroup Coordinator="RINCON_C" ID="RINCON_C:2">'
      + '<ZoneGroupMember UUID="RINCON_C" Location="http://192.0.2.14:1400/xml/device_description.xml" ZoneName="Bedroom"/>'
      + '</ZoneGroup>'
      + '<ZoneGroup Coordinator="RINCON_D" ID="RINCON_D:3">'
      + '<ZoneGroupMember UUID="RINCON_D" Location="http://192.0.2.15:1400/xml/device_description.xml" ZoneName="BOOST" IsZoneBridge="1"/>'
      + '</ZoneGroup>'
      + '</ZoneGroups></ZoneGroupState>';
    expect(parseZoneGroupState(xml)).toEqual([
      { uuid: 'RINCON_A', name: 'Living Room', address: '192.0.2.10', port: 1400, coordinator: 'RINCON_A' },
      { uuid: 'RINCON_B', name: 'Kitchen', address: '192.0.2.11', port: 1400, coordinator: 'RINCON_A' },
      { uuid: 'RINCON_C', name: 'Bedroom', address: '192.0.2.14', port: 1400, coordinator: 'RINCON_C' },
    ]);
    expect(parseZoneGroupState('')).toEqual([]);
  });
});

describe('selectRooms', () => {
  const rooms = ['Living Room', 'Kitchen'].map((name, i) => ({ uuid: `R${i}`, name, address: '192.0.2.1', port: 1400, coordinator: `R${i}` }));

  it('picks rooms by name, ignoring case, and reports the missing ones', () => {
    expect(selectRooms(rooms, [])).toEqual({ selected: rooms, missing: [] });
    expect(selectRooms(rooms, ['kitchen', 'Garage'])).toEqual({ selected: [rooms[1]], missing: ['Garage'] });
  });
});

describe('sourceKind', () => {
  it('names common sources', () => {
    expect(['', QUEUE, 'x-sonos-htastream:RINCON_A:spdif', 'x-rincon-stream:RINCON_A', 'x-rincon:RINCON_A',
      'x-sonos-vli:RINCON_A:1,airplay:abc', 'x-sonos-vli:RINCON_A:2,spotify:abc', RADIO].map(sourceKind))
      .toEqual(['nothing', 'queue', 'TV', 'line-in', 'grouped', 'AirPlay', 'Spotify Connect', 'stream']);
  });
});

describe('SonosSpeakers', () => {
  let sonos: FakeSonos;
  let audio: AudioServer;
  let log: ReturnType<typeof makeLogger>;

  async function setUp(players: FakePlayerInit[]): Promise<void> {
    sonos = new FakeSonos(players);
    await sonos.start();
  }

  function speakers(rooms: string[] = []): SonosSpeakers {
    return new SonosSpeakers({
      rooms,
      log,
      discovery: sonos.discovery,
      timings: { pollMs: 10, startTimeoutMs: 300, clipTimeoutMs: 1000, requestTimeoutMs: 500 },
    });
  }

  const calls = (room: string) => sonos.player(room).calls.filter((c) => !c.startsWith('Get'));

  beforeAll(async () => {
    audio = new AudioServer({ directory: path.join(__dirname, '..', 'audio'), port: 0 });
    await audio.start();
  });
  afterAll(() => audio.stop());
  beforeEach(() => {
    log = makeLogger();
  });
  afterEach(() => sonos.stop());

  it('announces in every room and puts back a playing queue at the same point', async () => {
    await setUp([
      { name: 'Living Room', uri: QUEUE, state: 'PLAYING', track: 4, relTime: '0:01:23', volume: 15 },
      { name: 'Kitchen', uri: RADIO, metadata: '<DIDL-Lite>radio</DIDL-Lite>', state: 'PAUSED_PLAYBACK', volume: 40, mute: true },
    ]);
    const session = await speakers().begin({ volume: 70 });
    expect(session.rooms).toEqual(['Living Room', 'Kitchen']);
    expect(session.localAddress).toBe('127.0.0.1');

    const url = audio.url('test', session.localAddress);
    await session.play(url);
    expect(sonos.fetched.sort()).toEqual([`Kitchen ${url}`, `Living Room ${url}`]);
    expect(sonos.player('Living Room').state).toBe('STOPPED');
    await session.end();

    expect(calls('Living Room')).toEqual([
      'SetVolume 70', `SetAVTransportURI ${url}`, 'Play',
      'SetVolume 15', `SetAVTransportURI ${QUEUE}`, 'Seek TRACK_NR 4', 'Seek REL_TIME 0:01:23', 'Play',
    ]);
    expect(calls('Kitchen')).toEqual([
      'SetMute 0', 'SetVolume 70', `SetAVTransportURI ${url}`, 'Play',
      'SetVolume 40', 'SetMute 1', `SetAVTransportURI ${RADIO}`,
    ]);
    expect(sonos.player('Kitchen')).toMatchObject({ uri: RADIO, metadata: '<DIDL-Lite>radio</DIDL-Lite>', state: 'STOPPED', mute: true, volume: 40 });
    expect(sonos.player('Living Room')).toMatchObject({ uri: QUEUE, state: 'PLAYING', track: 4, relTime: '0:01:23', volume: 15 });
  });

  it('only uses the configured rooms', async () => {
    await setUp([{ name: 'Living Room' }, { name: 'Kitchen' }]);
    const session = await speakers(['kitchen', 'Garage']).begin({ volume: 50 });
    expect(session.rooms).toEqual(['Kitchen']);
    expect(log.warn).toHaveBeenCalledWith('Sonos rooms not found: Garage');
    await session.play(audio.url('test', session.localAddress));
    await session.end();
    expect(calls('Living Room')).toEqual([]);
  });

  it('fails to begin when no configured room exists, listing the rooms it found', async () => {
    await setUp([{ name: 'Living Room' }, { name: 'Sub', invisible: true }]);
    await expect(speakers(['Garage']).begin({ volume: 50 }))
      .rejects.toThrow('none of the configured Sonos rooms were found (found: Living Room)');
  });

  it('takes a grouped room out of its group and puts it back', async () => {
    await setUp([{ name: 'Living Room', uri: QUEUE, state: 'PLAYING', volume: 30 }, { name: 'Kitchen', volume: 25 }]);
    sonos.group('Living Room', 'Kitchen');
    const coordinator = sonos.player('Living Room').uuid;
    const session = await speakers(['Kitchen']).begin({ volume: 60 });
    expect(sonos.player('Kitchen').coordinator).toBe(sonos.player('Kitchen').uuid);

    await session.play(audio.url('fire', session.localAddress));
    // The group it left kept playing.
    expect(sonos.player('Living Room')).toMatchObject({ state: 'PLAYING', uri: QUEUE });
    await session.end();
    expect(calls('Kitchen')).toEqual([
      'BecomeCoordinatorOfStandaloneGroup', 'SetVolume 60', `SetAVTransportURI ${audio.url('fire', '127.0.0.1')}`, 'Play',
      'SetVolume 25', `SetAVTransportURI x-rincon:${coordinator}`,
    ]);
    expect(sonos.player('Kitchen').coordinator).toBe(coordinator);
  });

  it('restores the coordinator before the rooms that rejoin it', async () => {
    await setUp([{ name: 'Living Room', uri: QUEUE, state: 'PLAYING' }, { name: 'Kitchen' }]);
    sonos.group('Living Room', 'Kitchen');
    const order: string[] = [];
    const session = await speakers().begin({ volume: 60 });
    await session.play(audio.url('test', session.localAddress));
    const before = sonos.players.map((p) => p.calls.length);
    await session.end();
    for (const [i, p] of sonos.players.entries()) {
      order.push(...p.calls.slice(before[i]).filter((c) => c.startsWith('SetAVTransportURI')).map((c) => `${p.name}: ${c}`));
    }
    expect(order).toEqual([`Living Room: SetAVTransportURI ${QUEUE}`, `Kitchen: SetAVTransportURI x-rincon:${sonos.player('Living Room').uuid}`]);
    expect(sonos.player('Kitchen').coordinator).toBe(sonos.player('Living Room').uuid);
  });

  it('resumes TV and line-in, but leaves Spotify Connect and AirPlay stopped', async () => {
    await setUp([
      { name: 'Living Room', uri: 'x-sonos-htastream:RINCON_000000000000001400:spdif', state: 'PLAYING' },
      { name: 'Kitchen', uri: 'x-sonos-vli:RINCON_000000000001001400:2,spotify:abc', state: 'PLAYING' },
      { name: 'Office', uri: 'x-sonos-vli:RINCON_000000000002001400:1,airplay:abc', state: 'PLAYING' },
      { name: 'Den', uri: 'x-rincon-stream:RINCON_000000000003001400', state: 'PLAYING' },
    ]);
    const session = await speakers().begin({ volume: 60 });
    await session.play(audio.url('test', session.localAddress));
    await session.end();
    expect(sonos.player('Living Room')).toMatchObject({ uri: 'x-sonos-htastream:RINCON_000000000000001400:spdif', state: 'PLAYING' });
    expect(sonos.player('Den')).toMatchObject({ uri: 'x-rincon-stream:RINCON_000000000003001400', state: 'PLAYING' });
    expect(sonos.player('Kitchen').state).toBe('STOPPED');
    expect(log.info).toHaveBeenCalledWith("Kitchen: Spotify Connect can't be resumed automatically; start it again from its app");
    expect(log.info).toHaveBeenCalledWith("Office: AirPlay can't be resumed automatically; start it again from its app");
  });

  it('carries on at the speaker volume when it is fixed', async () => {
    await setUp([{ name: 'Living Room', fixedVolume: true }]);
    const session = await speakers().begin({ volume: 60 });
    await session.play(audio.url('test', session.localAddress));
    await session.end();
    expect(sonos.fetched).toHaveLength(1);
  });

  it("doesn't let a room that's offline silence the others, and picks it up once it's back", async () => {
    await setUp([{ name: 'Living Room' }, { name: 'Kitchen', uri: RADIO, state: 'PLAYING', volume: 10 }]);
    const sp = speakers();
    await sp.findRooms();
    sonos.player('Kitchen').offline = true;
    const session = await sp.begin({ volume: 60 });
    const url = audio.url('burglar', session.localAddress);
    await session.play(url);
    expect(sonos.fetched).toEqual([`Living Room ${url}`]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/^Sonos Kitchen: /);

    await session.play(url);
    expect(log.warn).toHaveBeenCalledTimes(1); // Logged once, then quietly.

    sonos.player('Kitchen').offline = false;
    await session.play(url);
    expect(sonos.fetched.filter((f) => f.startsWith('Kitchen'))).toHaveLength(1);
    await session.end();
    expect(sonos.player('Kitchen')).toMatchObject({ uri: RADIO, state: 'PLAYING', volume: 10 });
  });

  it('fails to begin when no room can be reached, and a play fails when every room fails', async () => {
    await setUp([{ name: 'Living Room' }]);
    const sp = speakers();
    await sp.findRooms();
    sonos.player('Living Room').offline = true;
    await expect(sp.begin({ volume: 60 })).rejects.toThrow(/no Sonos/);

    sonos.player('Living Room').offline = false;
    const session = await sp.begin({ volume: 60 });
    sonos.player('Living Room').cannotFetch = true;
    await expect(session.play(audio.url('test', session.localAddress)))
      .rejects.toThrow("Living Room: the speaker didn't play the announcement (is the clip server reachable from it?)");
    await session.end();
  });

  it('gives up on a clip that never finishes', async () => {
    await setUp([{ name: 'Living Room' }]);
    sonos.clipMs = 5000;
    const session = await speakers().begin({ volume: 60 });
    await expect(session.play(audio.url('test', session.localAddress))).rejects.toThrow(/still playing after/);
    await session.end();
  });

  it("doesn't restore a clip left behind by an earlier announcement", async () => {
    await setUp([{ name: 'Living Room', uri: audio.url('test', '127.0.0.1'), state: 'STOPPED', volume: 12 }]);
    const session = await speakers().begin({ volume: 60 });
    await session.play(audio.url('test', session.localAddress));
    await session.end();
    expect(calls('Living Room').slice(-1)).toEqual(['SetVolume 12']);
  });

  it('tries known speakers before searching the network, and searches when they moved', async () => {
    await setUp([{ name: 'Living Room' }]);
    const sp = speakers();
    await sp.warmUp();
    expect(log.info).toHaveBeenCalledWith('Sonos rooms found: Living Room');
    const searches = sonos.searches;
    expect(searches).toBeGreaterThan(0);

    await (await sp.begin({ volume: 60 })).end();
    expect(sonos.searches).toBe(searches);

    sonos.player('Living Room').offline = true;
    await expect(sp.findRooms()).rejects.toThrow('no Sonos speakers answered on the network');
    expect(sonos.searches).toBeGreaterThan(searches);
  });

  it('warns at startup about configured rooms that do not exist', async () => {
    await setUp([{ name: 'Living Room' }, { name: 'Kitchen' }]);
    await speakers(['Living Room', 'Garage']).warmUp();
    expect(log.info).toHaveBeenCalledWith('Sonos rooms found: Kitchen, Living Room');
    expect(log.warn).toHaveBeenCalledWith('Sonos rooms not found: Garage (check the names in the plugin settings)');
  });
});
