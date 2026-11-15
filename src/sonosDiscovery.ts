import dgram from 'dgram';
import os from 'os';

/** Every Sonos speaker (and Boost/Bridge) answers for this device type. */
export const ZONE_PLAYER_TYPE = 'urn:schemas-upnp-org:device:ZonePlayer:1';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const RESEND_MS = 700;

export interface DiscoveredPlayer {
  /** IPv4 address, from the LOCATION header. */
  address: string;
  /** HTTP port of its UPnP services (1400 on real speakers). */
  port: number;
  /** "RINCON_..." */
  uuid?: string;
  /** Speakers set up in one Sonos system share a household. */
  household?: string;
}

export function buildSearch(): Buffer {
  return Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 1',
    `ST: ${ZONE_PLAYER_TYPE}`,
    '',
    '',
  ].join('\r\n'));
}

/** Parses one SSDP answer; undefined if it isn't from a Sonos player. */
export function parseSearchResponse(message: Buffer): DiscoveredPlayer | undefined {
  const lines = message.toString('utf8').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? '')) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  if (headers.st !== ZONE_PLAYER_TYPE && !/^uuid:RINCON_/i.test(headers.usn ?? '')) {
    return undefined;
  }
  const location = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?\//i.exec(headers.location ?? '');
  if (!location) {
    return undefined;
  }
  const uuid = /^uuid:(RINCON_[0-9A-Za-z]+)/.exec(headers.usn ?? '');
  return {
    address: location[1],
    port: location[2] ? Number(location[2]) : 80,
    uuid: uuid?.[1],
    household: headers['x-rincon-household'] || undefined,
  };
}

export interface PlayerDiscoveryOptions {
  /** Longest to wait for answers. */
  listenMs: number;
  /**
   * Once a speaker has answered, wait only this much longer for the others
   * (one per household is all that's needed to get the whole system).
   */
  settleMs?: number;
  /** Where to send the search; tests point this at a local responder. */
  address?: string;
  port?: number;
  /** Interface addresses to search from; defaults to every external IPv4 interface. */
  interfaces?: string[];
}

export function externalIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node 18.0-18.3 briefly reported `family` as a number.
      if (!entry.internal && (entry.family === 'IPv4' || (entry.family as unknown) === 4)) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

/**
 * Finds Sonos players with an SSDP search sent out of every IPv4 interface,
 * from an ephemeral port (players answer by unicast to it). Resolves with
 * what answered; an empty list means none did.
 */
export function discoverPlayers(options: PlayerDiscoveryOptions): Promise<DiscoveredPlayer[]> {
  const address = options.address ?? SSDP_ADDRESS;
  const port = options.port ?? SSDP_PORT;
  const interfaces = options.interfaces ?? (address === SSDP_ADDRESS ? externalIPv4Addresses() : []);
  const settleMs = options.settleMs ?? options.listenMs;

  return new Promise((resolve, reject) => {
    const found = new Map<string, DiscoveredPlayer>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      clearTimeout(settleTimer as NodeJS.Timeout);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      if (error) {
        reject(error);
      } else {
        resolve([...found.values()]);
      }
    };
    const timer = setTimeout(() => finish(), options.listenMs);

    socket.on('error', (error) => finish(error));
    socket.on('message', (message) => {
      const player = parseSearchResponse(message);
      if (!player) {
        return;
      }
      found.set(player.uuid ?? `${player.address}:${player.port}`, player);
      if (!settleTimer) {
        settleTimer = setTimeout(() => finish(), settleMs);
      }
    });
    socket.bind(0, () => {
      const search = buildSearch();
      const send = () => new Promise<void>((done) => socket.send(search, port, address, () => done()));
      const sendAll = async () => {
        if (!interfaces.length) {
          await send();
          return;
        }
        for (const iface of interfaces) {
          if (finished) {
            return;
          }
          try {
            socket.setMulticastInterface(iface);
          } catch {
            continue;
          }
          await send();
        }
      };
      void (async () => {
        // UDP gets lost; search again if nothing answered the first time.
        for (let attempt = 0; attempt < 3 && !finished && !found.size; attempt++) {
          await sendAll();
          await new Promise((done) => setTimeout(done, RESEND_MS).unref());
        }
      })();
    });
  });
}
