// Logging as the Go program does it (log.LstdFlags: "2006/01/02 15:04:05
// message"), so the logs of both read the same.

/** Writes one line of log. */
export type Logger = (line: string) => void;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A logger to standard error, each line stamped and prefixed. */
export const stderrLogger =
  (prefix = ''): Logger =>
  (line) => {
    process.stderr.write(`${stamp()} ${prefix}${line}\n`);
  };

/** A logger that drops everything. */
export const discard: Logger = () => {};

/** A logger that adds prefix to each line of another. */
export const prefixed =
  (logger: Logger, prefix: string): Logger =>
  (line) =>
    logger(prefix + line);
