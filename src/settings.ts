/**
 * Name users reference in the Homebridge config.json `platform` field.
 * Must match `pluginAlias` in config.schema.json.
 */
export const PLATFORM_NAME = 'RingAlarmSonosAnnouncer';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-ring-alarm-911-sonos-annunciator';

/** Port of the speakers' UPnP services. */
export const SONOS_PORT = 1400;

/** Speaker volume (1-100) while announcing. */
export const DEFAULT_VOLUME = 100;

/** Time from the start of one announcement to the start of the next. */
export const DEFAULT_REPEAT_INTERVAL_SECONDS = 10;
export const MIN_REPEAT_INTERVAL_SECONDS = 5;

/**
 * Announcements stop after this long even if the alarm is still going, so a
 * stuck state (or a lost "disarmed" event) can't loop forever.
 */
export const DEFAULT_MAX_ANNOUNCE_MINUTES = 15;

/** File in Homebridge's storage directory holding the latest (rotated) Ring refresh token. */
export const TOKEN_STORE_FILE = 'ring-alarm-sonos-announcer.json';
