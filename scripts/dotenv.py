#!/usr/bin/env -S python3 -I
"""Single canonical parser for the repository's gitignored `.env` file.

Used directly by Python tools (`e2e/machines/machines.py`,
`e2e/machines/winvm.py`) and by `scripts/load-env.sh` (which invokes this
script to read NUL-delimited KEY\\0VALUE\\0 pairs without ever calling `eval`
or `source` on `.env`).

Parsing rules:
- Blank lines and `#` comments are ignored.
- Optional leading `export ` prefix is stripped.
- Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`.
- Surrounding whitespace is trimmed; matching single or double quotes around a
  value are stripped (no shell expansion or command execution).
- A leading `~` or `~/` is expanded against `$HOME`.
- Existing environment variables are never overwritten (`setdefault`).
- Set `DOTENV_DISABLE=1` to skip loading `.env`.
"""
import os
import re
import sys

KEY_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def parse_dotenv(path):
    """Yields (key, value) pairs from path, or nothing when missing/disabled."""
    if os.environ.get('DOTENV_DISABLE') == '1' or not os.path.isfile(path):
        return
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\r\n').strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('export ') or line.startswith('export\t'):
                line = line[6:].lstrip()
            if '=' not in line:
                continue
            key, val = line.split('=', 1)
            key, val = key.strip(), val.strip()
            if not KEY_RE.match(key):
                continue
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            if val == '~' or val.startswith('~/'):
                val = os.path.expanduser(val)
            yield key, val


def load_dotenv(path):
    """Loads `.env` into `os.environ` without overriding already-set variables."""
    for key, val in parse_dotenv(path):
        os.environ.setdefault(key, val)


def main():
    if len(sys.argv) != 2:
        sys.stderr.write('usage: dotenv.py <path>\n')
        return 2
    out = sys.stdout.buffer
    for key, val in parse_dotenv(sys.argv[1]):
        out.write(key.encode('utf-8') + b'\0' + val.encode('utf-8') + b'\0')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
