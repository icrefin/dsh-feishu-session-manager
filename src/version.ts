/**
 * The plugin's own version, and the one source both halves read.
 *
 * The status route reports it so the settings page can prove which build the
 * running host actually loaded — the only honest answer to "did my reinstall
 * take?" while a restart is still pending — and the page prints it beside its
 * title. One module for both, because two constants would drift. A test compares
 * this value with `package.json`, so a release cannot advertise a version the
 * artifact is not.
 *
 * @module dsh-feishu-session-manager/version
 */

/** Package version, kept equal to `package.json`. */
export const VERSION = '0.1.8'

/**
 * The version chip's credit, verbatim.
 *
 * The workspace style contract requires the name and address to be literal copy
 * in one constant beside the version source — never translated, reworded, linked
 * or substituted. The page renders the chip as one text run:
 * `v{version} | Author: {AUTHORS}`.
 */
export const AUTHORS = 'icrefin [icrefinai@gmail.com]'