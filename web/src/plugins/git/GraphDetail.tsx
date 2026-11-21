// The Git graph pane's details under the selected row: a commit's
// message, people and files, a compare's files or the working tree's
// changes; a file opens its diff beside the graph.

import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { t, type MessageKey } from '../../i18n';
import { FileIcon } from '../../fileIcons';
import { gitApi, errorText, type Shown } from './api';
import { openDiff, openStatusDiff, short } from './ops';
import { fmtDate, folderOf, leafName, letterColor, letterMark } from './shared';
import type { Row } from './GraphPane';

/** A commit's details, a compare's files or the working tree's changes. */
export function Detail({
  m,
  repo,
  row,
  compare,
  onClose,
  onSelect,
}: {
  m: string;
  repo: string;
  row: Row;
  compare?: string;
  onClose(): void;
  onSelect(h: string): void;
}) {
  const [shown, setShown] = useState<Shown>();
  const [error, setError] = useState<string>();
  const [parent, setParent] = useState(1);
  const rev = row.hash;
  useEffect(() => setParent(1), [rev]);
  useEffect(() => {
    if (row.kind === 'uncommitted') return;
    let gone = false;
    setShown(undefined);
    setError(undefined);
    gitApi
      .show(m, repo, compare ? compare : rev, compare ? { rev2: rev } : { parent })
      .then((s) => !gone && setShown(s))
      .catch((e) => !gone && setError(errorText(e)));
    return () => {
      gone = true;
    };
  }, [m, repo, rev, compare, parent, row.kind]);

  if (row.kind === 'uncommitted') {
    return (
      <div className="git-detail">
        <div className="git-detail-head">
          <b>{t('git.graph.uncommitted', { n: row.files.length })}</b>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="git-detail-files">
          {row.files.map((f) => {
            const staged = f.x !== '.' && f.x !== '?' && f.kind !== 'unmerged';
            const letter = f.kind === 'untracked' ? 'U' : f.kind === 'unmerged' ? '!' : f.y !== '.' ? f.y : f.x;
            return (
              <FileLine
                key={f.path}
                path={f.path}
                letter={letter}
                title={f.orig ? `${f.orig} → ${f.path}` : f.path}
                onClick={() => void openStatusDiff(m, repo, f, staged && f.y === '.', { beside: true })}
              />
            );
          })}
        </div>
      </div>
    );
  }
  const c = shown?.commit;
  return (
    <div className="git-detail">
      <div className="git-detail-head">
        {compare ? (
          <b>{t('git.graph.comparing', { a: short(compare), b: short(rev) })}</b>
        ) : (
          <b className="ellipsis">{c?.subject ?? short(rev)}</b>
        )}
        <span className="spacer" />
        <button className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onClose}>
          <X />
        </button>
      </div>
      {error && <div className="git-error small">{error}</div>}
      <div className="git-detail-body">
        {c && !compare && (
          <div className="git-detail-meta small">
            <div>
              <span className="muted">{t('git.graph.commit')}</span> <code>{c.hash}</code>
            </div>
            <div>
              <span className="muted">{t('git.graph.parents')}</span>{' '}
              {c.parents.map((p, i) => (
                <button
                  key={p}
                  className={`link${c.parents.length > 1 && parent === i + 1 ? ' on' : ''}`}
                  onClick={() => (c.parents.length > 1 ? setParent(i + 1) : onSelect(p))}
                  title={c.parents.length > 1 ? t('git.graph.diffAgainst') : undefined}
                >
                  {short(p)}
                </button>
              ))}
            </div>
            <div>
              <span className="muted">{t('git.graph.author')}</span> {c.author} &lt;{c.email}&gt; · {fmtDate(c.date)}
            </div>
            {(c.committer !== c.author || c.commitDate !== c.date) && (
              <div>
                <span className="muted">{t('git.graph.committer')}</span> {c.committer} &lt;{c.committerEmail}&gt; · {fmtDate(c.commitDate)}
              </div>
            )}
            <pre className="git-detail-message">{c.message}</pre>
          </div>
        )}
        <div className="git-detail-files">
          {!shown && !error && <div className="muted small">{t('git.loading')}</div>}
          {shown?.files.map((f) => (
            <FileLine
              key={f.path}
              path={f.path}
              letter={f.status}
              title={f.orig ? `${f.orig} → ${f.path}` : f.path}
              onClick={() =>
                void openDiff(
                  m,
                  compare
                    ? { repo, path: f.path, orig: f.orig, mode: 'compare', rev: compare, rev2: rev }
                    : { repo, path: f.path, orig: f.orig, mode: 'commit', rev, parent: c && c.parents.length > 1 ? parent : undefined },
                  undefined,
                  { beside: true },
                )
              }
            >
              {f.binary ? (
                <span className="muted small">{t('git.graph.binary')}</span>
              ) : (
                <span className="small git-stat">
                  <span className="add">+{f.added}</span> <span className="del">−{f.deleted}</span>
                </span>
              )}
            </FileLine>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A file of a commit or of the working tree's changes: its icon, name
 * (in its letter's color) and folder, what the caller adds (lines added
 * and deleted) and its letter. */
export function FileLine({
  path,
  letter,
  title,
  onClick,
  children,
}: {
  path: string;
  letter: string;
  title?: string;
  onClick?(): void;
  children?: ReactNode;
}) {
  const color = letterColor(letter);
  const folder = folderOf(path);
  return (
    <div className={`git-file${letter === 'D' ? ' deleted' : ''}`} title={title ?? path} onClick={onClick}>
      <FileIcon name={leafName(path)} kind={path.endsWith('/') ? 'dir' : 'file'} />
      <span className="git-name ellipsis" style={{ color }}>
        {leafName(path)}
      </span>
      {folder && <span className="git-path ellipsis muted">{folder}</span>}
      <span className="spacer" />
      {children}
      <span className="git-letter" style={{ color }} aria-label={t(`git.mark.${letterMark(letter)}` as MessageKey)}>
        {letter}
      </span>
    </div>
  );
}
