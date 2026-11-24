// The one way a request fails: throw a Fail. The router answers it as
// {error: code, message} with its status and audits the code; handlers do
// not write error responses themselves. The code is what the UI reads (it
// shows translated text for it); the message is for logs and developers.

export class Fail extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }

  /** The answer's body. */
  body(): { error: string; message: string } {
    return { error: this.code, message: this.message };
  }
}

/** The Fail an error answers as: a Fail as it is; anything else is the
 * server's failure (500 failed), its message kept for the log. */
export function failOf(err: unknown): Fail {
  if (err instanceof Fail) return err;
  return new Fail('failed', 500, err instanceof Error ? err.message : String(err));
}

/** The machine has no agent session. */
export const offline = () => new Fail('offline', 409, 'machine not connected');

/** Refused in read-only mode. */
export const readOnly = () => new Fail('read_only', 403, 'read-only mode');

/** A feature that is off for the requesting client. */
export const featureOff = () => new Fail('plugin_disabled', 404);

/** An unknown machine in the path. */
export const unknownMachine = () => new Fail('unknown', 404, 'unknown machine');
