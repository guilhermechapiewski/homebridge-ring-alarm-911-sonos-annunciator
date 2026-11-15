import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import path from 'path';

import { CLIP_NAMES, ClipName } from './alarm';

export interface AudioServerOptions {
  /** Directory holding `<clip>.wav`. */
  directory: string;
  /** 0 picks a free port. */
  port: number;
  /** Interface to listen on; all of them by default. */
  host?: string;
}

const CLIP_PATH = /^\/clips\/([a-z-]+)\.wav$/;

/** "bytes=100-199" -> [100, 199] within `size`; undefined if unusable (serve it whole). */
export function parseRange(header: string | undefined, size: number): [number, number] | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!match || (!match[1] && !match[2])) {
    return undefined;
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    // "bytes=-500": the last 500 bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? 'unsatisfiable' : [start, end];
}

/**
 * Serves the announcement clips to the Sonos speakers, which fetch audio by
 * URL. Only the known clip names are served, nothing else from the disk.
 * Supports Range requests, which players use to probe and seek.
 */
export class AudioServer {
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  private port = 0;

  constructor(private readonly options: AudioServerOptions) {}

  /** Starts listening; resolves with the port. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.removeListener('error', onError);
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** URL of a clip for a client that reaches this machine at `address`. */
  url(clip: ClipName, address: string): string {
    const host = address.includes(':') ? `[${address}]` : address;
    return `http://${host}:${this.port}/clips/${clip}.wav`;
  }

  /** Clips missing from the directory (a packaging problem worth logging at startup). */
  missingClips(): ClipName[] {
    return CLIP_NAMES.filter((clip) => !fs.existsSync(this.fileFor(clip)));
  }

  private fileFor(clip: ClipName): string {
    return path.join(this.options.directory, `${clip}.wav`);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const match = CLIP_PATH.exec((req.url ?? '').split('?')[0]);
    const clip = match && (CLIP_NAMES as string[]).includes(match[1]) ? (match[1] as ClipName) : undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (!clip) {
      res.writeHead(404).end();
      return;
    }
    const file = this.fileFor(clip);
    fs.stat(file, (error, stats) => {
      if (error || !stats.isFile()) {
        res.writeHead(404).end();
        return;
      }
      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };
      const range = parseRange(req.headers.range, stats.size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stats.size}` }).end();
        return;
      }
      const [start, end] = range ?? [0, stats.size - 1];
      if (range) {
        headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || stats.size === 0) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }
}
