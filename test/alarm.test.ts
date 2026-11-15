import { ANNOUNCEMENT_STYLES, CLIP_NAMES, CLIP_TEXT, clipForAlarmState, isKnownAlarmState, KNOWN_ALARM_STATES } from '../src/alarm';

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
  it('has text for every clip in every style', () => {
    expect(CLIP_NAMES).toEqual(['burglar', 'fire', 'co', 'fire-or-co', 'panic', 'alarm', 'test']);
    expect(Object.keys(CLIP_TEXT).sort()).toEqual([...ANNOUNCEMENT_STYLES].sort());
    for (const style of ANNOUNCEMENT_STYLES) {
      expect(Object.keys(CLIP_TEXT[style]).sort()).toEqual([...CLIP_NAMES].sort());
      for (const clip of CLIP_NAMES) {
        expect(CLIP_TEXT[style][clip].length).toBeGreaterThan(5);
      }
    }
  });

  it('never promises help that might not come', () => {
    // Not everyone has professional monitoring, and nothing is dispatched if the alarm is cancelled.
    for (const style of ANNOUNCEMENT_STYLES) {
      for (const clip of CLIP_NAMES) {
        expect(CLIP_TEXT[style][clip]).not.toMatch(/911|police|on the way|monitoring|dispatch|fire department/i);
      }
    }
  });

  it('always tells everyone to leave for fire and carbon monoxide', () => {
    for (const style of ANNOUNCEMENT_STYLES) {
      for (const clip of ['fire', 'co', 'fire-or-co'] as const) {
        expect(CLIP_TEXT[style][clip]).toMatch(/leave the house|get out/i);
      }
    }
  });
});
