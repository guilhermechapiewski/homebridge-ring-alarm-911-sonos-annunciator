import dgram from 'dgram';

import { buildSearch, discoverPlayers, parseSearchResponse } from '../src/sonosDiscovery';
import { FakeSonos } from './fakeSonos';

const answer = (lines: string[]) => Buffer.from([...lines, '', ''].join('\r\n'));

describe('buildSearch', () => {
  it('searches for ZonePlayer devices', () => {
    expect(buildSearch().toString()).toBe('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\n'
      + 'MX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
  });
});

describe('parseSearchResponse', () => {
  it('reads a Sonos answer', () => {
    expect(parseSearchResponse(answer([
      'HTTP/1.1 200 OK',
      'LOCATION: http://192.0.2.20:1400/xml/device_description.xml',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
      'USN: uuid:RINCON_000000000001001400::urn:schemas-upnp-org:device:ZonePlayer:1',
      'X-RINCON-HOUSEHOLD: Sonos_abc',
    ]))).toEqual({ address: '192.0.2.20', port: 1400, uuid: 'RINCON_000000000001001400', household: 'Sonos_abc' });
  });

  it('ignores other devices, other messages and junk', () => {
    expect(parseSearchResponse(answer([
      'HTTP/1.1 200 OK', 'LOCATION: http://192.0.2.30:80/desc.xml', 'ST: upnp:rootdevice', 'USN: uuid:abc::upnp:rootdevice',
    ]))).toBeUndefined();
    expect(parseSearchResponse(answer(['NOTIFY * HTTP/1.1', 'ST: urn:schemas-upnp-org:device:ZonePlayer:1']))).toBeUndefined();
    expect(parseSearchResponse(answer(['HTTP/1.1 200 OK', 'ST: urn:schemas-upnp-org:device:ZonePlayer:1', 'LOCATION: nope']))).toBeUndefined();
    expect(parseSearchResponse(Buffer.from([0, 1, 2]))).toBeUndefined();
  });
});

describe('discoverPlayers', () => {
  it('finds every player and stops shortly after the first answer', async () => {
    const sonos = new FakeSonos([{ name: 'Living Room' }, { name: 'Kitchen' }]);
    await sonos.start();
    try {
      const started = Date.now();
      const players = await discoverPlayers({ ...sonos.discovery, listenMs: 2000, settleMs: 50 });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(players).toEqual(sonos.players.map((p) => ({ address: '127.0.0.1', port: p.port, uuid: p.uuid, household: 'Sonos_household1' })));
    } finally {
      await sonos.stop();
    }
  });

  it('searches again when nothing answered, and gives up after listenMs', async () => {
    const socket = dgram.createSocket('udp4');
    let searches = 0;
    socket.on('message', () => searches++);
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
    try {
      expect(await discoverPlayers({ address: '127.0.0.1', port: socket.address().port, listenMs: 1000 })).toEqual([]);
      expect(searches).toBe(2);
    } finally {
      socket.close();
    }
  });
});
