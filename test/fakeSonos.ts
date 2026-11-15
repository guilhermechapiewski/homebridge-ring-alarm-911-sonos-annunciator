import dgram from 'dgram';
import http from 'http';
import { AddressInfo } from 'net';

import { escapeXml, unescapeXml } from '../src/upnp';

export interface FakePlayerInit {
  name: string;
  uuid?: string;
  uri?: string;
  metadata?: string;
  state?: string;
  track?: number;
  relTime?: string;
  volume?: number;
  mute?: boolean;
  /** Fixed line-out volume: SetVolume fails. */
  fixedVolume?: boolean;
  /** Hidden half of a stereo pair, surround or sub. */
  invisible?: boolean;
  /** Boost / Bridge. */
  bridge?: boolean;
}

export class FakePlayer {
  readonly uuid: string;
  readonly name: string;
  uri: string;
  metadata: string;
  state: string;
  track: number;
  relTime: string;
  volume: number;
  mute: boolean;
  fixedVolume: boolean;
  invisible: boolean;
  bridge: boolean;
  /** UUID of the group coordinator; its own when standalone. */
  coordinator: string;
  /** Stops answering (connections are dropped). */
  offline = false;
  /** Speaker can't fetch clips (answers STOPPED without playing). */
  cannotFetch = false;
  port = 0;
  /** Every action, e.g. "SetVolume 70". */
  readonly calls: string[] = [];
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  private playTimer?: NodeJS.Timeout;

  constructor(private readonly system: FakeSonos, init: FakePlayerInit, index: number) {
    this.uuid = init.uuid ?? `RINCON_00000000000${index}01400`;
    this.name = init.name;
    this.uri = init.uri ?? '';
    this.metadata = init.metadata ?? '';
    this.state = init.state ?? 'STOPPED';
    this.track = init.track ?? 0;
    this.relTime = init.relTime ?? '0:00:00';
    this.volume = init.volume ?? 20;
    this.mute = init.mute ?? false;
    this.fixedVolume = !!init.fixedVolume;
    this.invisible = !!init.invisible;
    this.bridge = !!init.bridge;
    this.coordinator = this.uuid;
  }

  get location(): string {
    return `http://127.0.0.1:${this.port}/xml/device_description.xml`;
  }

  /** What GetMediaInfo reports. */
  get currentUri(): string {
    return this.coordinator === this.uuid ? this.uri : `x-rincon:${this.coordinator}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = (this.server.address() as AddressInfo).port;
      resolve();
    }));
  }

  stop(): Promise<void> {
    clearTimeout(this.playTimer as NodeJS.Timeout);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.offline) {
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const action = /#(\w+)"?$/.exec(String(req.headers.soapaction ?? ''))?.[1] ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const args: Record<string, string> = {};
      const inner = new RegExp(`<u:${action}[^>]*>([\\s\\S]*)</u:${action}>`).exec(body)?.[1] ?? '';
      for (const match of inner.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) {
        args[match[1]] = unescapeXml(match[2]);
      }
      try {
        const values = this.perform(action, args);
        const out = Object.entries(values).map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
        res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:x">${out}</u:${action}Response></s:Body></s:Envelope>`);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
        res.end('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>'
          + '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>'
          + `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${(error as Error).message}</errorCode></UPnPError>`
          + '</detail></s:Fault></s:Body></s:Envelope>');
      }
    });
  }

  private perform(action: string, args: Record<string, string>): Record<string, string | number> {
    const log = (detail = '') => this.calls.push(detail ? `${action} ${detail}` : action);
    switch (action) {
      case 'GetZoneGroupState':
        log();
        return { ZoneGroupState: this.system.zoneGroupState() };
      case 'GetMediaInfo':
        log();
        return { NrTracks: 1, CurrentURI: this.currentUri, CurrentURIMetaData: this.coordinator === this.uuid ? this.metadata : '' };
      case 'GetTransportInfo':
        return { CurrentTransportState: this.coordinator === this.uuid ? this.state : this.system.player(this.coordinator).state, CurrentSpeed: 1 };
      case 'GetPositionInfo':
        log();
        return { Track: this.track, RelTime: this.relTime, TrackURI: '' };
      case 'GetVolume':
        log();
        return { CurrentVolume: this.volume };
      case 'GetMute':
        log();
        return { CurrentMute: this.mute ? 1 : 0 };
      case 'SetVolume':
        log(args.DesiredVolume);
        if (this.fixedVolume) {
          throw new Error('803');
        }
        this.volume = Number(args.DesiredVolume);
        return {};
      case 'SetMute':
        log(args.DesiredMute);
        this.mute = args.DesiredMute === '1';
        return {};
      case 'SetAVTransportURI': {
        log(args.CurrentURI);
        clearTimeout(this.playTimer as NodeJS.Timeout);
        const join = /^x-rincon:(RINCON_\w+)$/.exec(args.CurrentURI);
        if (join) {
          this.coordinator = join[1];
          return {};
        }
        this.coordinator = this.uuid;
        this.uri = args.CurrentURI;
        this.metadata = args.CurrentURIMetaData ?? '';
        this.state = 'STOPPED';
        this.track = this.uri.startsWith('x-rincon-queue:') ? 1 : 0;
        this.relTime = '0:00:00';
        return {};
      }
      case 'Play':
        log();
        this.play();
        return {};
      case 'Seek':
        log(`${args.Unit} ${args.Target}`);
        if (args.Unit === 'TRACK_NR') {
          this.track = Number(args.Target);
        } else {
          this.relTime = args.Target;
        }
        return {};
      case 'BecomeCoordinatorOfStandaloneGroup':
        log();
        this.coordinator = this.uuid;
        this.uri = '';
        this.state = 'STOPPED';
        return {};
      default:
        throw new Error('401');
    }
  }

  private play(): void {
    if (!/^https?:/.test(this.uri)) {
      this.state = 'PLAYING';
      return;
    }
    this.state = 'TRANSITIONING';
    const fail = () => {
      this.state = 'STOPPED';
    };
    if (this.cannotFetch) {
      this.playTimer = setTimeout(fail, 20);
      return;
    }
    http.get(this.uri, (res) => {
      res.resume();
      if (res.statusCode !== 200) {
        fail();
        return;
      }
      this.system.fetched.push(`${this.name} ${this.uri}`);
      this.state = 'PLAYING';
      this.playTimer = setTimeout(() => {
        this.state = 'STOPPED';
      }, this.system.clipMs);
    }).on('error', fail);
  }
}

/**
 * A pretend Sonos system on 127.0.0.1: one HTTP server per speaker
 * answering the UPnP actions the plugin uses, plus an SSDP responder.
 */
export class FakeSonos {
  readonly players: FakePlayer[];
  /** How long a clip "plays" once fetched. */
  clipMs = 60;
  /** "<room> <url>" for every clip a speaker fetched and played. */
  readonly fetched: string[] = [];
  /** SSDP searches received. */
  searches = 0;
  ssdpPort = 0;
  household = 'Sonos_household1';
  private readonly ssdp = dgram.createSocket('udp4');

  constructor(players: FakePlayerInit[]) {
    this.players = players.map((init, index) => new FakePlayer(this, init, index));
  }

  player(nameOrUuid: string): FakePlayer {
    const found = this.players.find((p) => p.name === nameOrUuid || p.uuid === nameOrUuid);
    if (!found) {
      throw new Error(`no fake player ${nameOrUuid}`);
    }
    return found;
  }

  /** Puts `member` in `coordinator`'s group. */
  group(coordinator: string, ...members: string[]): void {
    for (const member of members) {
      this.player(member).coordinator = this.player(coordinator).uuid;
    }
  }

  zoneGroupState(): string {
    const groups = new Map<string, FakePlayer[]>();
    for (const player of this.players) {
      groups.set(player.coordinator, [...(groups.get(player.coordinator) ?? []), player]);
    }
    const xml = [...groups.entries()].map(([coordinator, members]) => `<ZoneGroup Coordinator="${coordinator}" ID="${coordinator}:1">`
      + members.map((p) => `<ZoneGroupMember UUID="${p.uuid}" Location="${p.location}" ZoneName="${escapeXml(p.name)}"`
        + `${p.invisible ? ' Invisible="1"' : ''}${p.bridge ? ' IsZoneBridge="1"' : ''} SoftwareVersion="80.1-1"/>`).join('')
      + '</ZoneGroup>').join('');
    return `<ZoneGroupState><ZoneGroups>${xml}</ZoneGroups><VanishedDevices></VanishedDevices></ZoneGroupState>`;
  }

  async start(): Promise<void> {
    await Promise.all(this.players.map((p) => p.start()));
    this.ssdp.on('message', (message, remote) => {
      if (!message.toString().startsWith('M-SEARCH')) {
        return;
      }
      this.searches++;
      for (const player of this.players.filter((p) => !p.offline)) {
        const answer = [
          'HTTP/1.1 200 OK',
          'CACHE-CONTROL: max-age = 1800',
          'EXT:',
          `LOCATION: ${player.location}`,
          'SERVER: Linux UPnP/1.0 Sonos/80.1-1 (ZPS1)',
          'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
          `USN: uuid:${player.uuid}::urn:schemas-upnp-org:device:ZonePlayer:1`,
          `X-RINCON-HOUSEHOLD: ${this.household}`,
          '',
          '',
        ].join('\r\n');
        this.ssdp.send(answer, remote.port, remote.address);
      }
    });
    await new Promise<void>((resolve) => this.ssdp.bind(0, '127.0.0.1', () => resolve()));
    this.ssdpPort = this.ssdp.address().port;
  }

  async stop(): Promise<void> {
    await Promise.all(this.players.map((p) => p.stop()));
    await new Promise<void>((resolve) => this.ssdp.close(() => resolve()));
  }

  /** Options for `SonosSpeakers` / `discoverPlayers` pointing at this system. */
  get discovery(): { address: string; port: number; listenMs: number; settleMs: number } {
    return { address: '127.0.0.1', port: this.ssdpPort, listenMs: 500, settleMs: 50 };
  }
}
