/**
 * What the Ring security panel reports in `alarmInfo.state` (from
 * ring-client-api's `AlarmState` type). Absent while no alarm is active.
 */
export const KNOWN_ALARM_STATES = [
  'entry-delay',
  'burglar-alarm',
  'burglar-accelerated-alarm',
  'user-verified-burglar-alarm',
  'fire-alarm',
  'fire-accelerated-alarm',
  'co-alarm',
  'user-verified-co-or-fire-alarm',
  'panic',
] as const;

/** Which announcement to play. `test` is only for the test switch. */
export type ClipName = 'burglar' | 'fire' | 'co' | 'fire-or-co' | 'panic' | 'alarm' | 'test';

/** How the announcements are worded; picked in the plugin settings. */
export type AnnouncementStyle = 'standard' | 'urgent' | 'deterrent';

export const ANNOUNCEMENT_STYLES: AnnouncementStyle[] = ['standard', 'urgent', 'deterrent'];
export const DEFAULT_ANNOUNCEMENT_STYLE: AnnouncementStyle = 'standard';

const TEST_TEXT = 'This is a test of the alarm announcer. No alarm is active.';
const STANDARD: Record<ClipName, string> = {
  burglar: 'Alarm triggered. Check the house and the Ring app.',
  fire: 'Fire alarm. Leave the house now.',
  co: 'Carbon monoxide alarm. Leave the house now.',
  'fire-or-co': 'Smoke or carbon monoxide alarm. Leave the house now.',
  panic: 'Panic alarm triggered. Check the house and the Ring app.',
  alarm: 'Alarm triggered.',
  test: TEST_TEXT,
};

/**
 * The words in each clip, per style. `scripts/make-clips.js` renders these
 * into `audio/<style>/<clip>.wav`; re-render after changing them.
 *
 * Nothing here may promise help that might not come: not everyone has
 * Ring's professional monitoring, its monitoring center usually calls
 * before dispatching, and nothing is dispatched if the alarm is cancelled.
 * A unit test guards this.
 */
export const CLIP_TEXT: Record<AnnouncementStyle, Record<ClipName, string>> = {
  standard: STANDARD,
  urgent: {
    burglar: 'Burglar alarm! Burglar alarm!',
    fire: 'Fire! Fire! Get out now!',
    co: 'Carbon monoxide! Get out now!',
    'fire-or-co': 'Smoke or carbon monoxide! Get out now!',
    panic: 'Panic alarm! Panic alarm!',
    alarm: 'Alarm! Alarm!',
    test: TEST_TEXT,
  },
  // Speaks to an intruder; fire and CO aren't about one, so they stay plain.
  deterrent: {
    ...STANDARD,
    burglar: 'Warning. The alarm has been triggered and the owners have been alerted. Leave now.',
    panic: 'Warning. An emergency alarm has been triggered. Help has been alerted.',
    alarm: 'Warning. The alarm has been triggered.',
  },
};

export const CLIP_NAMES = Object.keys(STANDARD) as ClipName[];

/**
 * Picks the announcement for a security-panel alarm state, or undefined when
 * nothing should be said:
 * - no state: no alarm;
 * - `entry-delay`: someone opened a door while armed. Usually it's someone
 *   coming home on the way to the keypad, so stay quiet until it actually goes off.
 *
 * States this plugin doesn't know yet still get the generic clip, since a
 * silent miss is worse than a vague announcement.
 */
export function clipForAlarmState(state: string | undefined): ClipName | undefined {
  if (!state || state === 'entry-delay') {
    return undefined;
  }
  switch (state) {
    case 'burglar-alarm':
    case 'burglar-accelerated-alarm':
    case 'user-verified-burglar-alarm':
      return 'burglar';
    case 'fire-alarm':
    case 'fire-accelerated-alarm':
      return 'fire';
    case 'co-alarm':
      return 'co';
    case 'user-verified-co-or-fire-alarm':
      return 'fire-or-co';
    case 'panic':
      return 'panic';
    default:
      return 'alarm';
  }
}

export function isKnownAlarmState(state: string): boolean {
  return (KNOWN_ALARM_STATES as readonly string[]).includes(state);
}
