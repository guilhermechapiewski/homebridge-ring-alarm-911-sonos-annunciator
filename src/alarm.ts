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

/**
 * The words in each clip. `scripts/make-clips.sh` renders these into
 * `audio/<name>.wav`; keep the two in sync.
 *
 * The wording avoids promising that police are coming: Ring's monitoring
 * center usually calls first, and nothing is dispatched if the alarm is
 * cancelled or there's no monitoring plan.
 */
export const CLIP_TEXT: Record<ClipName, string> = {
  burglar: 'Alarm triggered. The monitoring center has been notified.',
  fire: 'Fire alarm. Leave the house now.',
  co: 'Carbon monoxide alarm. Leave the house now.',
  'fire-or-co': 'Smoke or carbon monoxide alarm. Leave the house now.',
  panic: 'Panic alarm triggered. The monitoring center has been notified.',
  alarm: 'Alarm triggered.',
  test: 'This is a test of the alarm announcer. No alarm is active.',
};

export const CLIP_NAMES = Object.keys(CLIP_TEXT) as ClipName[];

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
