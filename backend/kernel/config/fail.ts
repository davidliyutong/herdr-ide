// The failures of a change of the settings or keybindings. Their answer
// carries the reason as detail too, which the web UI shows after the
// code's translation (web/src/settings.ts, web/src/keybindings.ts).
import { Fail } from '../fail.ts';

export class ConfigFail extends Fail {
  readonly detail: string | undefined;

  /** A failure with code and status; detail, when given, is also its
   * message. */
  constructor(code: string, status: number, message: string, detail?: string) {
    super(code, status, message);
    this.detail = detail;
  }

  override body(): { error: string; message: string; detail?: string } {
    return this.detail === undefined ? super.body() : { ...super.body(), detail: this.detail };
  }
}

/** A failure whose message is also the answer's detail. */
export const detailed = (code: string, status: number, message: string): ConfigFail => new ConfigFail(code, status, message, message);

/** A file that could not be written or read again before a change: the
 * server's failure (500 save), with the system's error. */
export function saveFailed(e: unknown): ConfigFail {
  return detailed('save', 500, e instanceof Error ? e.message : String(e));
}
