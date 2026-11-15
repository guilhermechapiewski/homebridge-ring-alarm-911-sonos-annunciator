import type { Logger } from 'homebridge';

import { DiscoveredPlayer, PlayerDiscoveryOptions, discoverPlayers } from './sonosDiscovery';
import {
  AV_TRANSPORT,
  RENDERING_CONTROL,
  SOAP_TIMEOUT_MS,
  SoapService,
  ZONE_GROUP_TOPOLOGY,
  elements,
  escapeXml,
  soapCall,
} from './upnp';

/**
 * The speakers taken over for one announcement. `begin` prepares them
 * (remembers what they were doing, sets the volume); `end` puts everything
 * back.
 */
export interface AnnouncementSession {
  /** Room names in this announcement, for the log. */
  readonly rooms: string[];
  /**
   * This machine's address on the interface the speakers are reached
   * through, i.e. where they can fetch the clips from.
   */
  readonly localAddress: string;
  /** Plays a clip on every speaker; resolves once it has finished playing. */
  play(url: string): Promise<void>;
  /** Restores what the speakers were doing before `begin`. */
  end(): Promise<void>;
}

export interface Speakers {
  begin(options: { volume: number }): Promise<AnnouncementSession>;
  /** Optional: looks for the speakers ahead of time and logs what it found. */
  warmUp?(): Promise<void>;
}

/** One room (zone) as Sonos shows it in its app. */
export interface SonosRoom {
  /** "RINCON_..." of the speaker that represents the room (the primary of a pair). */
  uuid: string;
  name: string;
  address: string;
  port: number;
  /** UUID of the coordinator of the group the room is in (itself if not grouped). */
  coordinator: string;
}

/**
 * Rooms in a `ZoneGroupTopology#GetZoneGroupState` answer. Leaves out what
 * isn't a room of its own: the hidden half of a stereo pair, home theater
 * surrounds and subs, and Boost/Bridge units.
 */
export function parseZoneGroupState(xml: string): SonosRoom[] {
  const rooms: SonosRoom[] = [];
  for (const group of elements(xml, 'ZoneGroup')) {
    const coordinator = group.attributes.Coordinator;
    for (const member of elements(group.inner, 'ZoneGroupMember')) {
      const a = member.attributes;
      if (a.Invisible === '1' || a.IsZoneBridge === '1' || !a.UUID || !a.ZoneName) {
        continue;
      }
      const location = /^http:\/\/([^/:]+)(?::(\d+))?\//i.exec(a.Location ?? '');
      if (!location) {
        continue;
      }
      rooms.push({
        uuid: a.UUID,
        name: a.ZoneName,
        address: location[1],
        port: location[2] ? Number(location[2]) : 80,
        coordinator: coordinator || a.UUID,
      });
    }
  }
  return rooms;
}

/** The rooms named in `wanted` (case-insensitive; empty = all), and the names not found. */
export function selectRooms(rooms: SonosRoom[], wanted: string[]): { selected: SonosRoom[]; missing: string[] } {
  if (!wanted.length) {
    return { selected: rooms, missing: [] };
  }
  const lower = wanted.map((name) => name.toLowerCase());
  return {
    selected: rooms.filter((room) => lower.includes(room.name.toLowerCase())),
    missing: wanted.filter((name) => !rooms.some((room) => room.name.toLowerCase() === name.toLowerCase())),
  };
}

/** What a room was doing before the announcement. */
export interface RoomSnapshot {
  /** Set when the room was part of another room's group: rejoin that coordinator. */
  joinedTo?: string;
  uri: string;
  metadata: string;
  /** PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING... */
  transportState: string;
  /** Queue position (1-based) and time into the track, for queue sources. */
  track: number;
  relTime: string;
  volume?: number;
  mute?: boolean;
}

/** Sources that can't be resumed by setting their URI back (Spotify Connect, AirPlay). */
function isResumable(uri: string): boolean {
  return uri !== '' && !uri.startsWith('x-sonos-vli:');
}

export function sourceKind(uri: string): string {
  if (!uri) {
    return 'nothing';
  }
  if (uri.startsWith('x-rincon-queue:')) {
    return 'queue';
  }
  if (uri.startsWith('x-sonos-htastream:')) {
    return 'TV';
  }
  if (uri.startsWith('x-rincon-stream:')) {
    return 'line-in';
  }
  if (uri.startsWith('x-rincon:')) {
    return 'grouped';
  }
  if (uri.startsWith('x-sonos-vli:')) {
    return /airplay/i.test(uri) ? 'AirPlay' : /spotify/i.test(uri) ? 'Spotify Connect' : 'app stream';
  }
  return 'stream';
}

/** DIDL-Lite metadata for a clip, so the Sonos app shows a sensible title. */
export function clipMetadata(url: string): string {
  return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"'
    + ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + '<item id="alarm-announcement" parentID="-1" restricted="true"><dc:title>Alarm announcement</dc:title>'
    + '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
    + `<res protocolInfo="http-get:*:audio/wav:*">${escapeXml(url)}</res></item></DIDL-Lite>`;
}

export interface SonosTimings {
  /** One SOAP request. */
  requestTimeoutMs: number;
  /** How often to check whether a clip has finished. */
  pollMs: number;
  /** A clip that hasn't started playing by then failed. */
  startTimeoutMs: number;
  /** A clip still playing after this is given up on. */
  clipTimeoutMs: number;
}

export const DEFAULT_TIMINGS: SonosTimings = {
  requestTimeoutMs: SOAP_TIMEOUT_MS,
  pollMs: 300,
  startTimeoutMs: 5000,
  clipTimeoutMs: 30_000,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SOAP calls to one room's speaker, with the room name in error messages. */
export class RoomControl {
  constructor(readonly room: SonosRoom, private readonly timings: SonosTimings) {}

  async call(service: SoapService, action: string, args: Array<[string, string | number]> = []): Promise<Record<string, string>> {
    try {
      const result = await soapCall(this.room.address, this.room.port, service, action, [['InstanceID', 0], ...args], this.timings.requestTimeoutMs);
      return result.values;
    } catch (error) {
      throw new Error(`${this.room.name}: ${(error as Error).message}`);
    }
  }

  async snapshot(): Promise<RoomSnapshot> {
    const media = await this.call(AV_TRANSPORT, 'GetMediaInfo');
    const uri = media.CurrentURI ?? '';
    const [transport, position, volume, mute] = await Promise.all([
      this.call(AV_TRANSPORT, 'GetTransportInfo'),
      this.call(AV_TRANSPORT, 'GetPositionInfo'),
      this.call(RENDERING_CONTROL, 'GetVolume', [['Channel', 'Master']]).catch(() => undefined),
      this.call(RENDERING_CONTROL, 'GetMute', [['Channel', 'Master']]).catch(() => undefined),
    ]);
    const joined = /^x-rincon:(RINCON_[0-9A-Za-z]+)/.exec(uri);
    const currentVolume = Number(volume?.CurrentVolume);
    return {
      joinedTo: joined?.[1],
      uri,
      metadata: media.CurrentURIMetaData ?? '',
      transportState: transport.CurrentTransportState ?? 'STOPPED',
      track: Number(position.Track) || 0,
      relTime: position.RelTime ?? '',
      volume: volume && Number.isFinite(currentVolume) ? currentVolume : undefined,
      mute: mute ? mute.CurrentMute === '1' : undefined,
    };
  }

  async setVolume(volume: number): Promise<void> {
    await this.call(RENDERING_CONTROL, 'SetVolume', [['Channel', 'Master'], ['DesiredVolume', volume]]);
  }

  async setMute(mute: boolean): Promise<void> {
    await this.call(RENDERING_CONTROL, 'SetMute', [['Channel', 'Master'], ['DesiredMute', mute ? 1 : 0]]);
  }

  async setUri(uri: string, metadata: string): Promise<void> {
    await this.call(AV_TRANSPORT, 'SetAVTransportURI', [['CurrentURI', uri], ['CurrentURIMetaData', metadata]]);
  }

  async play(): Promise<void> {
    await this.call(AV_TRANSPORT, 'Play', [['Speed', 1]]);
  }

  async seek(unit: 'TRACK_NR' | 'REL_TIME', target: string | number): Promise<void> {
    await this.call(AV_TRANSPORT, 'Seek', [['Unit', unit], ['Target', target]]);
  }

  async leaveGroup(): Promise<void> {
    await this.call(AV_TRANSPORT, 'BecomeCoordinatorOfStandaloneGroup');
  }

  async transportState(): Promise<string> {
    return (await this.call(AV_TRANSPORT, 'GetTransportInfo')).CurrentTransportState ?? '';
  }

  /** Plays `url` and resolves once the speaker has played it to the end. */
  async playClip(url: string): Promise<void> {
    await this.setUri(url, clipMetadata(url));
    await this.play();
    const started = Date.now();
    let playing = false;
    for (;;) {
      await sleep(this.timings.pollMs);
      const state = await this.transportState();
      const elapsed = Date.now() - started;
      if (state === 'PLAYING') {
        playing = true;
      } else if (state === 'STOPPED' || state === 'PAUSED_PLAYBACK') {
        if (playing) {
          return;
        }
        if (elapsed >= this.timings.startTimeoutMs) {
          throw new Error(`${this.room.name}: the speaker didn't play the announcement (is the clip server reachable from it?)`);
        }
      }
      if (elapsed >= this.timings.clipTimeoutMs) {
        throw new Error(`${this.room.name}: the announcement was still playing after ${Math.round(elapsed / 1000)}s`);
      }
    }
  }
}

interface RoomState {
  control: RoomControl;
  snapshot?: RoomSnapshot;
  /** Consecutive failures, to log the first one loudly and the rest quietly. */
  failures: number;
}

/** Is `uri` one of our own clips? (Left over if a previous restore failed.) */
function isOwnClip(uri: string, localAddress: string): boolean {
  return new RegExp(`^http://${localAddress.replace(/\./g, '\\.')}:\\d+/clips/[a-z-]+\\.wav$`).test(uri);
}

class SonosAnnouncement implements AnnouncementSession {
  readonly rooms: string[];
  private readonly states: RoomState[];

  constructor(
    rooms: SonosRoom[],
    readonly localAddress: string,
    private readonly volume: number,
    private readonly log: Logger,
    timings: SonosTimings,
  ) {
    this.rooms = rooms.map((room) => room.name);
    this.states = rooms.map((room) => ({ control: new RoomControl(room, timings), failures: 0 }));
  }

  /** Snapshots and sets up every room not done yet; returns how many are ready. */
  async prepare(): Promise<number> {
    await Promise.all(this.states.filter((state) => !state.snapshot).map(async (state) => {
      try {
        state.snapshot = await this.prepareRoom(state.control);
        state.failures = 0;
      } catch (error) {
        this.failed(state, error as Error);
      }
    }));
    return this.states.filter((state) => state.snapshot).length;
  }

  private async prepareRoom(control: RoomControl): Promise<RoomSnapshot> {
    const snapshot = await control.snapshot();
    if (isOwnClip(snapshot.uri, this.localAddress)) {
      // Nothing worth restoring: a previous announcement was left behind.
      snapshot.uri = '';
      snapshot.metadata = '';
      snapshot.transportState = 'STOPPED';
    }
    this.log.debug(`${control.room.name}: was ${snapshot.transportState.toLowerCase()} (${sourceKind(snapshot.uri)}`
      + `${snapshot.joinedTo ? `, grouped with ${snapshot.joinedTo}` : ''}), volume ${snapshot.volume ?? '?'}${snapshot.mute ? ', muted' : ''}`);
    if (snapshot.joinedTo) {
      // Play in this room on its own, rather than in someone else's group.
      await control.leaveGroup();
    }
    try {
      if (snapshot.mute) {
        await control.setMute(false);
      }
      await control.setVolume(this.volume);
    } catch (error) {
      // E.g. a Port/Amp set to fixed volume. Announce at whatever volume it has.
      this.log.debug(`${control.room.name}: unable to set the volume: ${(error as Error).message}`);
    }
    return snapshot;
  }

  async play(url: string): Promise<void> {
    await this.prepare();
    const ready = this.states.filter((state) => state.snapshot);
    const errors: Error[] = [];
    await Promise.all(ready.map(async (state) => {
      try {
        await state.control.playClip(url);
        state.failures = 0;
      } catch (error) {
        errors.push(error as Error);
        this.failed(state, error as Error);
      }
    }));
    if (!ready.length || errors.length === ready.length) {
      throw new Error(errors.length ? errors.map((e) => e.message).join('; ') : 'no Sonos room could be reached');
    }
  }

  async end(): Promise<void> {
    const ready = this.states.filter((state) => state.snapshot);
    const errors: string[] = [];
    // Rooms that were on their own (or led a group) first, then the ones that rejoin them.
    for (const rejoining of [false, true]) {
      await Promise.all(ready.filter((state) => !!state.snapshot?.joinedTo === rejoining).map(async (state) => {
        try {
          await this.restore(state.control, state.snapshot as RoomSnapshot);
        } catch (error) {
          errors.push((error as Error).message);
        }
      }));
    }
    if (errors.length) {
      throw new Error(errors.join('; '));
    }
  }

  private async restore(control: RoomControl, snapshot: RoomSnapshot): Promise<void> {
    const name = control.room.name;
    // Volume first, so resumed music doesn't come back at announcement volume.
    if (snapshot.volume !== undefined) {
      await control.setVolume(snapshot.volume).catch((error: Error) => this.log.debug(`${name}: unable to restore the volume: ${error.message}`));
    }
    if (snapshot.mute) {
      await control.setMute(true).catch((error: Error) => this.log.debug(`${name}: unable to mute it again: ${error.message}`));
    }
    if (snapshot.joinedTo) {
      await control.setUri(`x-rincon:${snapshot.joinedTo}`, '');
      return;
    }
    if (!isResumable(snapshot.uri)) {
      if (snapshot.uri) {
        this.log.info(`${name}: ${sourceKind(snapshot.uri)} can't be resumed automatically; start it again from its app`);
      }
      return;
    }
    if (snapshot.uri.startsWith('x-rincon-queue:')) {
      await control.setUri(snapshot.uri, '');
      try {
        if (snapshot.track > 0) {
          await control.seek('TRACK_NR', snapshot.track);
        }
        if (/^\d+:\d\d:\d\d$/.test(snapshot.relTime) && !/^0+:00:00$/.test(snapshot.relTime)) {
          await control.seek('REL_TIME', snapshot.relTime);
        }
      } catch (error) {
        this.log.debug(`${name}: unable to return to the same point in the queue: ${(error as Error).message}`);
      }
    } else {
      await control.setUri(snapshot.uri, snapshot.metadata);
    }
    if (snapshot.transportState === 'PLAYING' || snapshot.transportState === 'TRANSITIONING') {
      await control.play();
    }
  }

  private failed(state: RoomState, error: Error): void {
    state.failures++;
    if (state.failures === 1) {
      this.log.warn(`Sonos ${error.message}`);
    } else {
      this.log.debug(`Sonos ${error.message}`);
    }
  }
}

export interface SonosSpeakersOptions {
  /** Room names to use; empty means every room. */
  rooms: string[];
  log: Logger;
  /** Overrides for the SSDP search; tests point it at a local responder. */
  discovery?: Partial<PlayerDiscoveryOptions>;
  timings?: Partial<SonosTimings>;
}

/**
 * Dependency-free local Sonos control over UPnP, like the official apps.
 *
 * - Discovery: SSDP M-SEARCH for ZonePlayer devices on every IPv4
 *   interface, then `ZoneGroupTopology#GetZoneGroupState` on one speaker
 *   per household for every room, its address and group. Addresses from the
 *   last lookup are tried first, so an alarm doesn't wait for a search.
 * - Each room is handled on its own, so one that's asleep or offline
 *   doesn't silence the others (and is retried every round). A room that's
 *   in someone else's group is taken out of it for the announcement and put
 *   back after. A room that leads a group stays in it, so the group hears
 *   the announcement too.
 * - Snapshot once per announcement (`GetMediaInfo`, `GetTransportInfo`,
 *   `GetPositionInfo`, `GetVolume`, `GetMute`), never again during it.
 * - Restore: volume and mute, then the source (queue position and time,
 *   radio/TV/line-in URI), and play only if it was playing. Spotify Connect
 *   and AirPlay can't be resumed from here and are left stopped.
 */
export class SonosSpeakers implements Speakers {
  private readonly timings: SonosTimings;
  /** Speakers seen last time, tried before searching the network. */
  private known: Array<{ address: string; port: number }> = [];

  constructor(private readonly options: SonosSpeakersOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  async warmUp(): Promise<void> {
    const { rooms } = await this.findRooms();
    const { selected, missing } = selectRooms(rooms, this.options.rooms);
    const names = (list: SonosRoom[]) => [...new Set(list.map((room) => room.name))].sort().join(', ');
    this.options.log.info(`Sonos rooms found: ${names(rooms) || 'none'}`);
    if (missing.length) {
      this.options.log.warn(`Sonos rooms not found: ${missing.join(', ')} (check the names in the plugin settings)`);
    } else if (this.options.rooms.length) {
      this.options.log.debug(`Announcing in: ${names(selected)}`);
    }
  }

  async begin(options: { volume: number }): Promise<AnnouncementSession> {
    const { rooms, localAddress } = await this.findRooms();
    const { selected, missing } = selectRooms(rooms, this.options.rooms);
    if (missing.length) {
      this.options.log.warn(`Sonos rooms not found: ${missing.join(', ')}`);
    }
    if (!selected.length) {
      throw new Error(`none of the configured Sonos rooms were found (found: ${rooms.map((room) => room.name).join(', ') || 'none'})`);
    }
    const session = new SonosAnnouncement(selected, localAddress, options.volume, this.options.log, this.timings);
    if (!(await session.prepare())) {
      throw new Error('no Sonos room could be reached');
    }
    return session;
  }

  /** Every room in every Sonos household on the network. */
  async findRooms(): Promise<{ rooms: SonosRoom[]; localAddress: string }> {
    for (const player of this.known) {
      try {
        const found = await this.topology([player]);
        this.remember(found.rooms);
        return found;
      } catch {
        // Moved or offline; try the next one, then search.
      }
    }
    const players = await discoverPlayers({ listenMs: 3000, settleMs: 500, ...this.options.discovery });
    if (!players.length) {
      throw new Error('no Sonos speakers answered on the network');
    }
    const found = await this.topology(players);
    this.remember(found.rooms);
    return found;
  }

  private remember(rooms: SonosRoom[]): void {
    const seen = new Set<string>();
    this.known = [];
    for (const room of rooms) {
      const key = `${room.address}:${room.port}`;
      if (!seen.has(key)) {
        seen.add(key);
        this.known.push({ address: room.address, port: room.port });
      }
    }
  }

  /** Asks one speaker per household for its rooms. */
  private async topology(players: Array<Pick<DiscoveredPlayer, 'address' | 'port' | 'household'>>): Promise<{ rooms: SonosRoom[]; localAddress: string }> {
    const households = new Map<string, Array<Pick<DiscoveredPlayer, 'address' | 'port'>>>();
    for (const player of players) {
      const key = player.household ?? '';
      households.set(key, [...(households.get(key) ?? []), player]);
    }
    const rooms: SonosRoom[] = [];
    let localAddress = '';
    let lastError: Error | undefined;
    for (const candidates of households.values()) {
      for (const player of candidates) {
        try {
          const result = await soapCall(player.address, player.port, ZONE_GROUP_TOPOLOGY, 'GetZoneGroupState', [], this.timings.requestTimeoutMs);
          for (const room of parseZoneGroupState(result.values.ZoneGroupState ?? '')) {
            if (!rooms.some((known) => known.uuid === room.uuid)) {
              rooms.push(room);
            }
          }
          localAddress = localAddress || result.localAddress;
          break;
        } catch (error) {
          lastError = error as Error;
        }
      }
    }
    if (!localAddress) {
      throw lastError ?? new Error('no Sonos speaker answered');
    }
    return { rooms, localAddress };
  }
}
