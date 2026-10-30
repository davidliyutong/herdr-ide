import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  placeholder?: string;
  className?: string;
  /** Enter or leaving the field saves; Escape cancels. */
  onDone(value: string | undefined): void;
}

/** Text field that replaces a label while it is renamed. */
export function InlineEdit({ value, placeholder, className, onDone }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? ref.current!.value.trim() : undefined);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <input
      ref={ref}
      className={`inline-edit ${className ?? ''}`}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
    />
  );
}
