import { useEffect, useRef, useState } from 'react';
import { TermController, type TermOptions, type TermStatus } from '../terminal/TermController';
import { t, type MessageKey } from '../i18n';

interface Props extends Omit<TermOptions, 'onStatus'> {
  active?: boolean;
  registerController?(c: TermController | undefined): void;
}

const statusKey: Record<TermStatus, MessageKey | undefined> = {
  connecting: 'term.connecting',
  observe: 'term.observe',
  closed: 'term.closed',
  error: 'term.error',
  open: undefined,
};

export function TerminalView(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<TermController>(undefined);
  const [status, setStatus] = useState<{ s: TermStatus; msg?: string }>({ s: 'connecting' });
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const el = hostRef.current!;
    const ctl = new TermController(el, {
      m: props.m,
      pane: props.pane,
      mode: props.mode,
      fontSize: props.fontSize,
      onStatus: (s, msg) => setStatus({ s, msg }),
      onFocus: () => propsRef.current.onFocus?.(),
      onKey: (ev) => propsRef.current.onKey?.(ev) ?? false,
      onPasteFiles: (files) => propsRef.current.onPasteFiles?.(files) ?? Promise.resolve(undefined),
      linkProvider: props.linkProvider,
    });
    ctlRef.current = ctl;
    props.registerController?.(ctl);
    return () => {
      props.registerController?.(undefined);
      ctl.dispose();
      ctlRef.current = undefined;
    };
    // The stream is keyed by machine/pane/mode; other props are read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.m, props.pane, props.mode]);

  useEffect(() => {
    if (props.active) ctlRef.current?.focus();
  }, [props.active]);

  return (
    <div className="term-wrap">
      <div className="term-host" ref={hostRef} />
      {status.s !== 'open' && (
        <div className={`term-overlay ${status.s}`}>
          <span>{statusKey[status.s] ? t(statusKey[status.s]!) : status.s}</span>
          {status.msg && <span className="term-overlay-msg">{status.msg}</span>}
          {(status.s === 'closed' || status.s === 'error') && (
            <button onClick={() => ctlRef.current?.attach(true)}>{t('term.reconnect')}</button>
          )}
          {status.s === 'observe' && props.mode !== 'observe' && (
            <button onClick={() => ctlRef.current?.claim()}>{t('term.takeOver')}</button>
          )}
        </div>
      )}
    </div>
  );
}
