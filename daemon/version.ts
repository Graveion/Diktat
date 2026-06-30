// Single source of truth for the daemon version. Bump on each release; the
// release pipeline publishes the matching artifact + updates docs/version.json
// so the app can detect when a paired daemon is out of date.
export const DAEMON_VERSION = "0.1.0";
