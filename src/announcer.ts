import type { Logger } from 'homebridge';

import { ClipName, clipForAlarmState } from './alarm';
import type { AnnouncementSession, Speakers } from './sonos';

export interface AnnouncerDeps {
  speakers: Speakers;
  /** URL the speakers fetch a clip from, given this machine's address on their network. */
  clipUrl: (clip: ClipName, localAddress: string) => string;
  log: Logger;
  volume: number;
  /** From the start of one announcement to the start of the next. */
  repeatIntervalMs: number;
  /** Stop announcing after this long, even if the alarm is still active. */
  maxDurationMs: number;
  now?: () => number;
}

/**
 * Turns alarm states into announcements: while an alarm is active (and
 * announcements are enabled), the matching clip plays every
 * `repeatIntervalMs` until the alarm clears, then the speakers go back to
 * what they were doing.
 *
 * Everything runs in one loop, so an alarm that starts during a test
 * announcement takes over the same speakers, and an alarm that escalates
 * (e.g. burglar, then fire) switches clips on the next round.
 */
export class Announcer {
  private readonly now: () => number;
  private enabled = true;
  /** Clip for the current alarm, if one is active. */
  private alarmClip?: ClipName;
  /** The current alarm went on longer than `maxDurationMs`; quiet until it clears. */
  private timedOut = false;
  private pendingTest = false;
  private disposed = false;
  private running?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly deps: AnnouncerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True while the speakers are taken over (alarm or test). */
  get isAnnouncing(): boolean {
    return this.running !== undefined;
  }

  /** Feeds the security panel's `alarmInfo.state` (undefined = no alarm). */
  update(alarmState: string | undefined): void {
    const clip = clipForAlarmState(alarmState);
    if (clip === this.alarmClip) {
      return;
    }
    const previous = this.alarmClip;
    this.alarmClip = clip;
    if (clip) {
      this.deps.log.warn(`Ring alarm: ${alarmState}${this.enabled ? '; announcing on Sonos' : ' (announcements are off)'}`);
      if (this.enabled) {
        this.ensureRunning();
      }
    } else {
      this.timedOut = false;
      if (previous) {
        this.deps.log.info(`Ring alarm cleared${alarmState ? ` (${alarmState})` : ''}`);
      }
    }
    this.wake?.();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.deps.log.info(`Alarm announcements turned ${enabled ? 'on' : 'off'}`);
    if (enabled && this.alarmClip) {
      this.ensureRunning();
    }
    this.wake?.();
  }

  /** Plays the test clip once. Skipped while an alarm is being announced. */
  test(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.nextAlarmClip()) {
      this.deps.log.info('Test announcement skipped: an alarm is being announced');
      return Promise.resolve();
    }
    this.deps.log.info('Playing the test announcement');
    this.pendingTest = true;
    return this.ensureRunning();
  }

  /** Stops announcing and restores the speakers. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.wake?.();
    return this.running ?? Promise.resolve();
  }

  private nextAlarmClip(): ClipName | undefined {
    return !this.disposed && this.enabled && !this.timedOut ? this.alarmClip : undefined;
  }

  private nextClip(): ClipName | undefined {
    const alarm = this.nextAlarmClip();
    if (alarm) {
      return alarm;
    }
    if (this.pendingTest && !this.disposed) {
      this.pendingTest = false;
      return 'test';
    }
    return undefined;
  }

  private ensureRunning(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
        // An alarm or a test may have come in while the speakers were being restored.
        if ((this.pendingTest || this.nextAlarmClip()) && !this.disposed) {
          void this.ensureRunning();
        }
      });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    const { log } = this.deps;
    let session: AnnouncementSession | undefined;
    let alarmStartedAt: number | undefined;
    let failures = 0;
    try {
      for (;;) {
        const clip = this.nextClip();
        if (!clip) {
          return;
        }
        if (clip !== 'test') {
          if (alarmStartedAt === undefined) {
            alarmStartedAt = this.now();
          }
          if (this.now() - alarmStartedAt >= this.deps.maxDurationMs) {
            this.timedOut = true;
            log.warn(`Stopped announcing after ${Math.round(this.deps.maxDurationMs / 60_000)} min; the alarm is still active in Ring`);
            continue;
          }
        }
        const cycleStart = this.now();
        try {
          if (!session) {
            session = await this.deps.speakers.begin({ volume: this.deps.volume });
            log.info(`Announcing on ${session.rooms.join(', ') || 'Sonos'}`);
          }
          await session.play(this.deps.clipUrl(clip, session.localAddress));
          failures = 0;
        } catch (error) {
          failures++;
          const message = `Announcement failed: ${(error as Error).message}`;
          if (failures === 1) {
            log.error(clip === 'test' ? message : `${message} (will keep trying while the alarm is active)`);
          } else {
            log.debug(message);
          }
        }
        if (clip !== 'test') {
          await this.wait(clip, this.deps.repeatIntervalMs - (this.now() - cycleStart));
        }
      }
    } finally {
      if (session) {
        try {
          await session.end();
        } catch (error) {
          log.warn(`Unable to restore the speakers after the announcement: ${(error as Error).message}`);
        }
      }
    }
  }

  /**
   * Waits `ms` after playing `clip`, or less if there's something different
   * to do: the alarm changed or cleared, announcements were turned off, or
   * `dispose` was called, including while the clip was still playing.
   */
  private wait(clip: ClipName, ms: number): Promise<void> {
    if (ms <= 0 || this.nextAlarmClip() !== clip) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      // Only cut the pause short when there's something different to do.
      this.wake = () => {
        if (this.nextAlarmClip() !== clip) {
          done();
        }
      };
    });
  }
}
