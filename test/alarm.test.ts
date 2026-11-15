import { CLIP_NAMES, CLIP_TEXT, clipForAlarmState, isKnownAlarmState, KNOWN_ALARM_STATES } from '../src/alarm';

describe('clipForAlarmState', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['entry-delay', undefined],
    ['burglar-alarm', 'burglar'],
    ['burglar-accelerated-alarm', 'burglar'],
    ['user-verified-burglar-alarm', 'burglar'],
    ['fire-alarm', 'fire'],
    ['fire-accelerated-alarm', 'fire'],
    ['co-alarm', 'co'],
    ['user-verified-co-or-fire-alarm', 'fire-or-co'],
    ['panic', 'panic'],
    ['flood-alarm-from-the-future', 'alarm'],
  ])('%p -> %p', (state, clip) => {
    expect(clipForAlarmState(state)).toBe(clip);
  });

  it('maps every known state except entry-delay to a clip', () => {
    for (const state of KNOWN_ALARM_STATES) {
      expect(isKnownAlarmState(state)).toBe(true);
      expect(clipForAlarmState(state) === undefined).toBe(state === 'entry-delay');
    }
    expect(isKnownAlarmState('something-else')).toBe(false);
  });
});

describe('CLIP_TEXT', () => {
  it('has text for every clip and never promises that 911 is coming', () => {
    expect(CLIP_NAMES).toEqual(expect.arrayContaining(['burglar', 'fire', 'co', 'fire-or-co', 'panic', 'alarm', 'test']));
    for (const clip of CLIP_NAMES) {
      expect(CLIP_TEXT[clip].length).toBeGreaterThan(5);
      expect(CLIP_TEXT[clip]).not.toMatch(/911|on the way/i);
    }
  });
});
