import { Announcer, AnnouncerDeps } from '../src/announcer';
import { FakeSpeakers, makeLogger, sleep, waitFor } from './helpers';

describe('Announcer', () => {
  let speakers: FakeSpeakers;
  let log: ReturnType<typeof makeLogger>;
  let announcer: Announcer;

  const make = (overrides: Partial<AnnouncerDeps> = {}) => new Announcer({
    speakers,
    clipUrl: (clip, address) => `http://${address}/${clip}`,
    log,
    volume: 70,
    repeatIntervalMs: 40,
    maxDurationMs: 10_000,
    ...overrides,
  });

  beforeEach(() => {
    speakers = new FakeSpeakers();
    log = makeLogger();
    announcer = make();
  });

  afterEach(async () => {
    await announcer.dispose();
  });

  it('stays quiet with no alarm and during the entry delay', async () => {
    announcer.update(undefined);
    announcer.update('entry-delay');
    await sleep(30);
    expect(speakers.events).toEqual([]);
    expect(announcer.isAnnouncing).toBe(false);
  });

  it('repeats the clip until the alarm clears, then restores the speakers', async () => {
    announcer.update('entry-delay');
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.plays.length >= 3);
    announcer.update(undefined);
    await waitFor(() => !announcer.isAnnouncing);

    expect(speakers.events[0]).toBe('begin 70');
    expect(new Set(speakers.plays)).toEqual(new Set(['http://192.0.2.5/burglar']));
    expect(speakers.events[speakers.events.length - 1]).toBe('end');
    expect(speakers.events.filter((event) => event === 'begin 70')).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('Ring alarm: burglar-alarm; announcing on Sonos');
    expect(log.info).toHaveBeenCalledWith('Ring alarm cleared');
  });

  it('stops right away when the alarm clears mid-pause', async () => {
    announcer = make({ repeatIntervalMs: 60_000 });
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.plays.length === 1);
    await sleep(20);
    announcer.update(undefined);
    await waitFor(() => !announcer.isAnnouncing, 500);
    expect(speakers.events).toEqual(['begin 70', 'play http://192.0.2.5/burglar', 'end']);
  });

  it('switches clips when the alarm escalates, without waiting out the pause', async () => {
    announcer = make({ repeatIntervalMs: 60_000 });
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.plays.length === 1);
    await sleep(20);
    announcer.update('fire-alarm');
    await waitFor(() => speakers.plays.length === 2, 500);
    expect(speakers.plays).toEqual(['http://192.0.2.5/burglar', 'http://192.0.2.5/fire']);
  });

  it('does nothing while turned off, and starts if turned on mid-alarm', async () => {
    announcer.setEnabled(false);
    announcer.update('co-alarm');
    await sleep(30);
    expect(speakers.events).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Ring alarm: co-alarm (announcements are off)');

    announcer.setEnabled(true);
    await waitFor(() => speakers.plays.length === 1);
    expect(speakers.plays).toEqual(['http://192.0.2.5/co']);

    announcer.setEnabled(false);
    await waitFor(() => !announcer.isAnnouncing);
    expect(speakers.events[speakers.events.length - 1]).toBe('end');
  });

  it('gives up after the maximum duration and re-arms once the alarm clears', async () => {
    let now = 0;
    announcer = make({ now: () => now, maxDurationMs: 1000, repeatIntervalMs: 5 });
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.plays.length >= 2);
    now = 1000;
    await waitFor(() => !announcer.isAnnouncing);
    expect(log.warn).toHaveBeenCalledWith('Stopped announcing after 0 min; the alarm is still active in Ring');
    const plays = speakers.plays.length;

    announcer.update('burglar-alarm'); // same alarm, still active: stay quiet
    await sleep(20);
    expect(speakers.plays).toHaveLength(plays);

    announcer.update(undefined);
    announcer.update('panic');
    await waitFor(() => speakers.plays.includes('http://192.0.2.5/panic'));
  });

  it('keeps trying when the speakers fail, logging the first failure as an error', async () => {
    speakers.beginError = new Error('no speakers found');
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.events.length >= 3);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('Announcement failed: no speakers found (will keep trying while the alarm is active)');

    speakers.beginError = undefined;
    await waitFor(() => speakers.plays.length >= 1);
  });

  it('plays the test clip once and restores', async () => {
    await announcer.test();
    expect(speakers.events).toEqual(['begin 70', 'play http://192.0.2.5/test', 'end']);
    expect(announcer.isAnnouncing).toBe(false);
  });

  it('reports a failed test without retrying', async () => {
    speakers.beginError = new Error('no speakers found');
    await announcer.test();
    expect(speakers.events).toEqual(['begin 70']);
    expect(log.error).toHaveBeenCalledWith('Announcement failed: no speakers found');
  });

  it('skips the test during an alarm, and an alarm during a test takes over', async () => {
    speakers.playMs = 30;
    const test = announcer.test();
    await waitFor(() => speakers.plays.length === 1);
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.plays.length >= 2);
    expect(speakers.plays.slice(0, 2)).toEqual(['http://192.0.2.5/test', 'http://192.0.2.5/burglar']);
    expect(speakers.events.filter((event) => event.startsWith('begin'))).toHaveLength(1);

    await announcer.test();
    expect(log.info).toHaveBeenCalledWith('Test announcement skipped: an alarm is being announced');
    announcer.update(undefined);
    await test;
  });

  it('restores the speakers on dispose', async () => {
    announcer.update('burglar-alarm');
    await waitFor(() => speakers.plays.length === 1);
    await announcer.dispose();
    expect(speakers.events[speakers.events.length - 1]).toBe('end');
    expect(announcer.isAnnouncing).toBe(false);
  });
});
