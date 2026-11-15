import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

interface StoredToken {
  /** Hash of the token in the config when this one was saved, to notice a newly pasted token. */
  configTokenHash: string;
  refreshToken: string;
  updatedAt: string;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Keeps the latest Ring refresh token. Ring rotates it on every use, so the
 * one in the config goes stale; the current one lives in a file in
 * Homebridge's storage directory (HOOBS configs are encrypted and can't be
 * rewritten by a plugin anyway).
 *
 * The config wins when it changes: pasting a fresh token into the settings
 * replaces whatever was stored.
 */
export class TokenStore {
  constructor(private readonly file: string) {}

  /** The token to use, given the one currently in the config. */
  current(configToken: string): string {
    const stored = this.read();
    return stored && stored.configTokenHash === hash(configToken) ? stored.refreshToken : configToken;
  }

  /** Saves a rotated token (atomically, readable only by the Homebridge user). */
  save(configToken: string, refreshToken: string): void {
    const data: StoredToken = { configTokenHash: hash(configToken), refreshToken, updatedAt: new Date().toISOString() };
    const temp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  private read(): StoredToken | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredToken>;
      if (typeof data.refreshToken === 'string' && data.refreshToken && typeof data.configTokenHash === 'string') {
        return data as StoredToken;
      }
    } catch {
      // Missing or unreadable: fall back to the config's token.
    }
    return undefined;
  }
}
