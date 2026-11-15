import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { AudioServer, parseRange } from '../src/audioServer';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string, options: http.RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

describe('parseRange', () => {
  it.each([
    [undefined, undefined],
    ['bytes=0-9', [0, 9]],
    ['bytes=5-', [5, 99]],
    ['bytes=-10', [90, 99]],
    ['bytes=90-500', [90, 99]],
    ['bytes=100-', 'unsatisfiable'],
    ['bytes=9-3', 'unsatisfiable'],
    ['bytes=-', undefined],
    ['bytes=0-1,5-6', undefined],
    ['items=0-1', undefined],
  ])('%p -> %p', (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });
});

describe('AudioServer', () => {
  let directory: string;
  let server: AudioServer;
  let base: string;
  const clip = Buffer.from(Array.from({ length: 100 }, (_, i) => i));

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'announcer-audio-'));
    fs.writeFileSync(path.join(directory, 'burglar.wav'), clip);
    fs.writeFileSync(path.join(directory, 'secret.wav'), 'not a clip');
    server = new AudioServer({ directory, port: 0, host: '127.0.0.1' });
    await server.start();
    base = server.url('burglar', '127.0.0.1').replace('/clips/burglar.wav', '');
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('builds clip URLs, bracketing IPv6 addresses', () => {
    expect(server.url('fire', '192.0.2.5')).toMatch(/^http:\/\/192\.0\.2\.5:\d+\/clips\/fire\.wav$/);
    expect(server.url('fire', 'fe80::1')).toMatch(/^http:\/\/\[fe80::1\]:\d+\/clips\/fire\.wav$/);
  });

  it('lists the clips missing from the directory', () => {
    expect(server.missingClips()).toEqual(['fire', 'co', 'fire-or-co', 'panic', 'alarm', 'test']);
  });

  it('serves a clip', async () => {
    const res = await request(`${base}/clips/burglar.wav`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['content-length']).toBe('100');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body.equals(clip)).toBe(true);
  });

  it('answers HEAD without a body', async () => {
    const res = await request(`${base}/clips/burglar.wav`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('100');
    expect(res.body.length).toBe(0);
  });

  it('serves byte ranges', async () => {
    const res = await request(`${base}/clips/burglar.wav`, { headers: { Range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 10-19/100');
    expect(res.body.equals(clip.subarray(10, 20))).toBe(true);

    const bad = await request(`${base}/clips/burglar.wav`, { headers: { Range: 'bytes=200-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */100');
  });

  it('serves only known clips that exist', async () => {
    expect((await request(`${base}/clips/fire.wav`)).status).toBe(404);
    expect((await request(`${base}/clips/secret.wav`)).status).toBe(404);
    expect((await request(`${base}/clips/..%2Fsecret.wav`)).status).toBe(404);
    expect((await request(`${base}/burglar.wav`)).status).toBe(404);
    expect((await request(`${base}/clips/burglar.wav`, { method: 'POST' })).status).toBe(405);
  });

  it('reports a port that is already taken', async () => {
    const port = Number(new URL(base).port);
    const second = new AudioServer({ directory, port, host: '127.0.0.1' });
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
  });
});
