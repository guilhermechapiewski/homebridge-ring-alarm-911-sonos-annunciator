import http from 'http';
import { AddressInfo } from 'net';

import {
  AV_TRANSPORT,
  UpnpError,
  elements,
  escapeXml,
  parseSoapResponse,
  soapCall,
  soapEnvelope,
  tagText,
  unescapeXml,
} from '../src/upnp';
import { FakeSonos } from './fakeSonos';

describe('XML helpers', () => {
  it('escapes and unescapes', () => {
    const text = '<a href="x">Tom & Jerry\'s</a>';
    expect(escapeXml(text)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;');
    expect(unescapeXml(escapeXml(text))).toBe(text);
    expect(unescapeXml('&#233;&#xE9;&unknown;&#xFFFFFFF;')).toBe('éé&unknown;&#xFFFFFFF;');
    // Only one level at a time, so doubly escaped XML stays escaped once.
    expect(unescapeXml('&amp;lt;')).toBe('&lt;');
  });

  it('finds tag text with or without a namespace prefix', () => {
    expect(tagText('<s:Body><errorCode>701</errorCode></s:Body>', 'errorCode')).toBe('701');
    expect(tagText('<u:CurrentURI>a&amp;b</u:CurrentURI>', 'CurrentURI')).toBe('a&b');
    expect(tagText('<Empty/>', 'Empty')).toBe('');
    expect(tagText('<Other>1</Other>', 'Missing')).toBeUndefined();
  });

  it('lists elements with their attributes, without matching longer tag names', () => {
    const xml = '<ZoneGroups><ZoneGroup Coordinator="A" ID=\'g1\'><ZoneGroupMember UUID="A" ZoneName="Tom &amp; Kitchen"/>'
      + '<ZoneGroupMember UUID="B"><Satellite UUID="C"/></ZoneGroupMember></ZoneGroup><ZoneGroup Coordinator="D"/></ZoneGroups>';
    const groups = elements(xml, 'ZoneGroup');
    expect(groups.map((g) => g.attributes)).toEqual([{ Coordinator: 'A', ID: 'g1' }, { Coordinator: 'D' }]);
    const members = elements(groups[0].inner, 'ZoneGroupMember');
    expect(members.map((m) => m.attributes)).toEqual([{ UUID: 'A', ZoneName: 'Tom & Kitchen' }, { UUID: 'B' }]);
    expect(members[1].inner).toBe('<Satellite UUID="C"/>');
  });

  it('builds a SOAP envelope with escaped arguments', () => {
    const xml = soapEnvelope(AV_TRANSPORT, 'SetAVTransportURI', [['InstanceID', 0], ['CurrentURI', 'http://x/?a=1&b=2']]);
    expect(xml).toContain('<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">');
    expect(xml).toContain('<InstanceID>0</InstanceID><CurrentURI>http://x/?a=1&amp;b=2</CurrentURI>');
  });

  it('reads the output arguments of a response', () => {
    const xml = '<s:Envelope><s:Body><u:GetMediaInfoResponse xmlns:u="x"><NrTracks>3</NrTracks>'
      + '<CurrentURI>x-rincon-queue:RINCON_1#0</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite/&gt;</CurrentURIMetaData>'
      + '<NextURI/></u:GetMediaInfoResponse></s:Body></s:Envelope>';
    expect(parseSoapResponse(xml, 'GetMediaInfo')).toEqual({
      NrTracks: '3', CurrentURI: 'x-rincon-queue:RINCON_1#0', CurrentURIMetaData: '<DIDL-Lite/>', NextURI: '',
    });
    expect(parseSoapResponse(xml, 'Play')).toEqual({});
  });
});

describe('soapCall', () => {
  const sonos = new FakeSonos([{ name: 'Living Room', volume: 33, fixedVolume: true }]);
  beforeAll(() => sonos.start());
  afterAll(() => sonos.stop());
  const port = () => sonos.players[0].port;

  it('calls an action and reports the local address used', async () => {
    const result = await soapCall('127.0.0.1', port(), { controlPath: '/MediaRenderer/RenderingControl/Control', type: 'urn:x' }, 'GetVolume', [['InstanceID', 0]]);
    expect(result).toEqual({ values: { CurrentVolume: '33' }, localAddress: '127.0.0.1' });
  });

  it('rejects with the UPnP error code on a fault', async () => {
    const error = await soapCall('127.0.0.1', port(), AV_TRANSPORT, 'SetVolume', [['InstanceID', 0], ['DesiredVolume', 5]]).catch((e) => e);
    expect(error).toBeInstanceOf(UpnpError);
    expect(error).toMatchObject({ code: 803, status: 500, message: 'SetVolume failed with UPnP error 803 (HTTP 500)' });
  });

  it('times out', async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      await expect(soapCall('127.0.0.1', (server.address() as AddressInfo).port, AV_TRANSPORT, 'Play', [], 50))
        .rejects.toThrow('Play: no answer from 127.0.0.1 within 50ms');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects when nothing is listening', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const free = (server.address() as AddressInfo).port;
    await new Promise((resolve) => server.close(resolve));
    await expect(soapCall('127.0.0.1', free, AV_TRANSPORT, 'Play')).rejects.toThrow(/ECONNREFUSED/);
  });
});
