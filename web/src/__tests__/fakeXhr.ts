// A stand-in for XMLHttpRequest uploads in tests: each request is recorded,
// and either answered at once by a reply function or driven by the test
// (progress, sent, respond, fail). Install it with
// vi.stubGlobal('XMLHttpRequest', FakeXhr).

type Handler = ((e: { loaded: number }) => void) | null;

export class FakeXhr {
  static requests: FakeXhr[] = [];
  /** Answers each request on the next tick when set: [status, JSON body]. */
  static reply: ((url: string) => [number, unknown]) | undefined;

  method = '';
  url = '';
  body: unknown;
  status = 0;
  statusText = '';
  responseText = '';
  aborted = false;
  upload: { onprogress: Handler; onload: Handler } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  static reset() {
    FakeXhr.requests = [];
    FakeXhr.reply = undefined;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: unknown) {
    this.body = body;
    FakeXhr.requests.push(this);
    const reply = FakeXhr.reply;
    if (reply)
      setTimeout(() => {
        const [status, json] = reply(this.url);
        this.sent();
        this.respond(status, json);
      });
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number) {
    this.upload.onprogress?.({ loaded });
  }

  sent() {
    this.upload.onload?.({ loaded: 0 });
  }

  respond(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }

  fail() {
    this.onerror?.();
  }
}
