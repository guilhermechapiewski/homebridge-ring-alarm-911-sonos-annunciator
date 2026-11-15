import http from 'http';

/** Default time to wait for a speaker to answer one request. */
export const SOAP_TIMEOUT_MS = 5000;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name] ?? entity;
  });
}

/** The text of the first `<tag>` (any namespace prefix), unescaped; undefined if absent. */
export function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`).exec(xml);
  if (!match) {
    return undefined;
  }
  return unescapeXml(match[1] ?? '');
}

/** One XML element's attributes plus the raw markup inside it. */
export interface XmlElement {
  attributes: Record<string, string>;
  inner: string;
}

/**
 * Every `<tag ...>` element in `xml`, in order. Good enough for the flat,
 * machine-written XML Sonos produces; nested elements with the same tag are
 * not supported (Sonos doesn't nest them).
 */
export function elements(xml: string, tag: string): XmlElement[] {
  const found: XmlElement[] = [];
  const pattern = new RegExp(`<${tag}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    found.push({ attributes: parseAttributes(match[1] ?? ''), inner: match[3] ?? '' });
  }
  return found;
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    attributes[match[1]] = unescapeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

/** A UPnP fault from the speaker, e.g. 701 "transition not available". */
export class UpnpError extends Error {
  constructor(readonly action: string, readonly code: number | undefined, readonly status: number) {
    super(`${action} failed${code !== undefined ? ` with UPnP error ${code}` : ''} (HTTP ${status})`);
    this.name = 'UpnpError';
  }
}

export interface SoapService {
  /** e.g. "/MediaRenderer/AVTransport/Control" */
  controlPath: string;
  /** e.g. "urn:schemas-upnp-org:service:AVTransport:1" */
  type: string;
}

export const AV_TRANSPORT: SoapService = {
  controlPath: '/MediaRenderer/AVTransport/Control',
  type: 'urn:schemas-upnp-org:service:AVTransport:1',
};
export const RENDERING_CONTROL: SoapService = {
  controlPath: '/MediaRenderer/RenderingControl/Control',
  type: 'urn:schemas-upnp-org:service:RenderingControl:1',
};
export const ZONE_GROUP_TOPOLOGY: SoapService = {
  controlPath: '/ZoneGroupTopology/Control',
  type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
};

export interface SoapResult {
  /** The response's output arguments, unescaped. */
  values: Record<string, string>;
  /** This machine's address on the connection to the speaker. */
  localAddress: string;
}

export function soapEnvelope(service: SoapService, action: string, args: Array<[string, string | number]>): string {
  const body = args.map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`).join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${service.type}">${body}</u:${action}></s:Body></s:Envelope>`;
}

/** Reads the output arguments out of a `<u:ActionResponse>` body. */
export function parseSoapResponse(xml: string, action: string): Record<string, string> {
  const response = new RegExp(`<(?:[\\w-]+:)?${action}Response(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${action}Response>)`).exec(xml);
  const values: Record<string, string> = {};
  const inner = response?.[1] ?? '';
  const pattern = /<([\w-]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (let match = pattern.exec(inner); match; match = pattern.exec(inner)) {
    values[match[1]] = unescapeXml(match[2] ?? '');
  }
  return values;
}

/** Strips the IPv4-mapped IPv6 prefix Node sometimes reports. */
function plainAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/i, '');
}

/**
 * One SOAP call to a speaker at `host:port`. Rejects with `UpnpError` on a
 * fault, or a plain `Error` on network trouble or a timeout.
 */
export function soapCall(
  host: string,
  port: number,
  service: SoapService,
  action: string,
  args: Array<[string, string | number]> = [],
  timeoutMs = SOAP_TIMEOUT_MS,
): Promise<SoapResult> {
  const payload = Buffer.from(soapEnvelope(service, action, args), 'utf8');
  return new Promise((resolve, reject) => {
    let localAddress = '';
    const req = http.request({
      host,
      port,
      path: service.controlPath,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': payload.length,
        SOAPACTION: `"${service.type}#${action}"`,
        Connection: 'close',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          const code = tagText(text, 'errorCode');
          reject(new UpnpError(action, code !== undefined && /^\d+$/.test(code.trim()) ? Number(code) : undefined, status));
          return;
        }
        resolve({ values: parseSoapResponse(text, action), localAddress });
      });
    });
    req.on('socket', (socket) => {
      const remember = () => {
        localAddress = plainAddress(socket.localAddress);
      };
      if (socket.localAddress) {
        remember();
      } else {
        socket.once('connect', remember);
      }
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${action}: no answer from ${host} within ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}
