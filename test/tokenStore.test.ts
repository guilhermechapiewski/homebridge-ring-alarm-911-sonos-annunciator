import fs from 'fs';
import os from 'os';
import path from 'path';

import { TokenStore } from '../src/tokenStore';

describe('TokenStore', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'announcer-token-'));
    file = path.join(directory, 'token.json');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('uses the config token until a rotated one is saved', () => {
    const store = new TokenStore(file);
    expect(store.current('config-token')).toBe('config-token');
    store.save('config-token', 'rotated-1');
    store.save('config-token', 'rotated-2');
    expect(new TokenStore(file).current('config-token')).toBe('rotated-2');
  });

  it('prefers a newly pasted config token over the stored one', () => {
    const store = new TokenStore(file);
    store.save('old-config-token', 'rotated');
    expect(store.current('new-config-token')).toBe('new-config-token');
  });

  it('writes the file readable only by its owner, without leaving temp files', () => {
    new TokenStore(file).save('config-token', 'rotated');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['token.json']);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('config-token');
  });

  it('falls back to the config token when the file is corrupt', () => {
    fs.writeFileSync(file, '{not json');
    expect(new TokenStore(file).current('config-token')).toBe('config-token');
    fs.writeFileSync(file, JSON.stringify({ refreshToken: 7 }));
    expect(new TokenStore(file).current('config-token')).toBe('config-token');
  });
});
