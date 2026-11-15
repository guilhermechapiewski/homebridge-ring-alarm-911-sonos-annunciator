import type { Logger } from 'homebridge';

import type { AnnouncementSession, Speakers } from '../src/sonos';

export function makeLogger(): jest.Mocked<Logger> {
  const log = jest.fn() as unknown as jest.Mocked<Logger>;
  Object.assign(log, {
    prefix: 'test',
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
    log: jest.fn(),
  });
  return log;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `condition` until it holds (or fails the test after `timeoutMs`). */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await sleep(5);
  }
}

/** Speakers that record what they were asked to do. */
export class FakeSpeakers implements Speakers {
  /** Everything that happened, in order: "begin 70", "play <url>", "end". */
  readonly events: string[] = [];
  beginError?: Error;
  playError?: Error;
  playMs = 5;

  get plays(): string[] {
    return this.events.filter((event) => event.startsWith('play ')).map((event) => event.slice(5));
  }

  async begin(options: { volume: number }): Promise<AnnouncementSession> {
    this.events.push(`begin ${options.volume}`);
    if (this.beginError) {
      throw this.beginError;
    }
    return {
      rooms: ['Living Room', 'Kitchen'],
      localAddress: '192.0.2.5',
      play: async (url) => {
        this.events.push(`play ${url}`);
        await sleep(this.playMs);
        if (this.playError) {
          throw this.playError;
        }
      },
      end: async () => {
        this.events.push('end');
      },
    };
  }
}
