#!/bin/sh
# Installs the veldr CLI (hub and machine binary) from GitHub Releases,
# verifying both the release archive and the extracted executable against
# the release's SHA256SUMS manifest before putting the binary in place.
#
#   curl -fsSL https://veldr.app/cli/install.sh | sh
#   curl -fsSL https://veldr.app/cli/install.sh | sh -s -- --version v0.6.0 --bin-dir ~/.local/bin
#
# Environment overrides:
#   VELDR_VERSION        Release tag to install (e.g. v0.6.0); default: latest
#   VELDR_INSTALL_DIR    Target bin directory; default: $HOME/.local/bin
#   VELDR_GITHUB_REPO    GitHub owner/repo; default: davidliyutong/veldr
#   VELDR_GITHUB_URL     GitHub base URL; default: https://github.com
#   VELDR_RELEASE_URL    Direct release asset base URL override (mirrors/tests)
set -eu

SLUG="veldr"
DEFAULT_REPO="davidliyutong/veldr"
MAX_SUMS=1048576
MAX_ARCHIVE=268435456

usage() {
  cat <<EOF
Usage: install.sh [options]

Install the ${SLUG} CLI from GitHub Releases.

Options:
  -v, --version <tag>   Install a specific release (e.g. v0.6.0; default: latest)
  -b, --bin-dir <dir>   Install directory (default: \$HOME/.local/bin)
  -h, --help            Show this help message

Environment:
  VELDR_VERSION         Same as --version
  VELDR_INSTALL_DIR     Same as --bin-dir
  VELDR_GITHUB_REPO     GitHub repository (default: ${DEFAULT_REPO})
  VELDR_RELEASE_URL     Direct asset base URL override (containing SHA256SUMS)
EOF
}

err() {
  printf '%s: error: %s\n' "$SLUG" "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

VERSION="${VELDR_VERSION:-}"
INSTALL_DIR="${VELDR_INSTALL_DIR:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    -v | --version)
      [ $# -ge 2 ] || err "--version requires an argument"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    -b | --bin-dir)
      [ $# -ge 2 ] || err "--bin-dir requires an argument"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --bin-dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      err "unknown option: $1 (try --help)"
      ;;
  esac
done

if [ -z "$INSTALL_DIR" ]; then
  [ -n "${HOME:-}" ] || err "HOME is not set; pass --bin-dir <dir>"
  INSTALL_DIR="$HOME/.local/bin"
fi

if [ -n "$VERSION" ]; then
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
  case "$TAG" in
    *[!A-Za-z0-9._-]* | *..*) err "invalid version tag: $VERSION" ;;
  esac
else
  TAG=""
fi

detect_platform() {
  raw_os="${VELDR_TEST_OS:-$(uname -s)}"
  case "$raw_os" in
    Linux | linux) os="linux" ;;
    Darwin | darwin) os="darwin" ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      err "Windows runs ${SLUG} via the desktop installer (${SLUG}-<version>-win-x64.exe on https://veldr.app)"
      ;;
    *) err "unsupported operating system: $raw_os" ;;
  esac

  raw_arch="${VELDR_TEST_ARCH:-$(uname -m)}"
  case "$raw_arch" in
    x86_64 | amd64)
      arch="amd64"
      # On Apple Silicon running an x86_64 shell under Rosetta 2, prefer native arm64.
      if [ "$os" = "darwin" ] && [ -z "${VELDR_TEST_ARCH:-}" ]; then
        if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
          arch="arm64"
        fi
      fi
      ;;
    aarch64 | arm64 | armv8l) arch="arm64" ;;
    *) err "unsupported CPU architecture: $raw_arch" ;;
  esac

  suffix=""
  if [ "$os" = "linux" ]; then
    if [ "$arch" = "amd64" ] && [ -r /proc/cpuinfo ] && [ -z "${VELDR_TEST_OS:-}" ]; then
      if ! grep -qw sse4_2 /proc/cpuinfo 2>/dev/null; then
        err "this x86_64 CPU lacks SSE4.2, which the ${SLUG} runtime requires"
      fi
    fi
    gnulibc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    ldd_out=$(ldd --version 2>&1 | head -n 1 || true)
    if printf '%s\n%s\n' "$gnulibc" "$ldd_out" | grep -qiE 'glibc|gnu libc'; then
      libc="glibc"
    elif printf '%s\n' "$ldd_out" | grep -qi 'musl' || ls /lib/ld-musl-* >/dev/null 2>&1; then
      libc="musl"
    else
      libc="glibc"
    fi
    if [ "$libc" = "musl" ]; then
      suffix="-musl"
      if [ -z "${VELDR_TEST_OS:-}" ]; then
        for lib in libstdc++.so.6 libgcc_s.so.1; do
          found=""
          for d in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib; do
            if [ -e "$d/$lib" ]; then
              found=1
              break
            fi
          done
          [ -n "$found" ] || err "musl build needs libstdc++ and libgcc (Alpine: apk add libstdc++ libgcc)"
        done
      fi
    fi
  fi

  PLATFORM="${os}-${arch}${suffix}"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else
    err "none of sha256sum, shasum or openssl is installed to verify downloads"
  fi
}

check_wget_redirects() {
  hdr="$1"
  want_scheme="$2"
  src_url="$3"
  [ "$want_scheme" = "https" ] || return 0
  awk '
    {
      sub(/\r$/, "")
      if (match($0, /^[[:space:]]*[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]:[[:space:]]*/)) {
        val = substr($0, RLENGTH + 1)
        sub(/[[:space:]].*$/, "", val)
        if (match(val, /^[A-Za-z][A-Za-z0-9+.-]*:/)) {
          s = tolower(substr(val, 1, RLENGTH - 1))
          if (s != "https") exit 1
        }
      }
    }
  ' "$hdr" || err "refused non-HTTPS redirect while downloading $src_url"
}

wget_last_location() {
  awk '
    {
      sub(/\r$/, "")
      if (match($0, /^[[:space:]]*[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]:[[:space:]]*/)) {
        val = substr($0, RLENGTH + 1)
        sub(/[[:space:]].*$/, "", val)
        loc = val
      }
    }
    END { if (loc != "") print loc }
  ' "$1"
}

resolve_redirect_url() {
  base="$1"
  loc="$2"
  want_scheme="$3"
  case "$loc" in
    https://*)
      [ "$want_scheme" = "https" ] || [ "$want_scheme" = "http" ] || err "refused redirect to unsupported scheme: $loc"
      printf '%s\n' "$loc"
      ;;
    http://*)
      [ "$want_scheme" = "http" ] || err "refused non-HTTPS redirect to $loc"
      printf '%s\n' "$loc"
      ;;
    //*)
      printf '%s:%s\n' "$want_scheme" "$loc"
      ;;
    /*)
      origin=$(printf '%s\n' "$base" | sed -n 's#^\([A-Za-z][A-Za-z0-9+.-]*://[^/]*\).*#\1#p')
      [ -n "$origin" ] || err "cannot resolve relative redirect: $loc"
      printf '%s%s\n' "$origin" "$loc"
      ;;
    *:*)
      err "refused redirect to unsupported scheme: $loc"
      ;;
    *)
      base_no_q="${base%%\?*}"
      printf '%s/%s\n' "${base_no_q%/*}" "$loc"
      ;;
  esac
}

run_wget_capped() {
  out_file="$1"
  cap_bytes="$2"
  rc_out="$3"
  hdr_out="$4"
  rc_empty="$5"
  shift 5
  rm -f "$rc_out" "$hdr_out"
  (
    set +e
    WGETRC="$rc_empty" "$@" 2>"$hdr_out"
    printf '%s\n' "$?" > "$rc_out"
  ) | head -c "$((cap_bytes + 1))" > "$out_file"
}

fetch_file() {
  url="$1"
  out="$2"
  cap="$3"
  limit_s="$4"
  case "$url" in
    https://*) scheme="https" ;;
    http://*) scheme="http" ;;
    *) err "unsupported URL scheme: $url" ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -q -fsSL --proto "=$scheme" --proto-redir "=$scheme" \
      --max-filesize "$cap" --max-redirs 5 --connect-timeout 10 --max-time "$limit_s" \
      -o "$out" "$url" || err "failed to download $url"
  elif command -v wget >/dev/null 2>&1; then
    rc_empty="$TMP_DIR/.wgetrc"
    rc_file="$TMP_DIR/.wget.rc"
    hdr_file="$TMP_DIR/.wget.hdr"
    : > "$rc_empty"
    wget_help=$(LC_ALL=C wget --help 2>&1 || true)
    if wget --version 2>/dev/null | grep -q 'GNU Wget'; then
      cur_url="$url"
      hops=0
      while :; do
        case "$wget_help" in
          *--no-config*)
            run_wget_capped "$out" "$cap" "$rc_file" "$hdr_file" "$rc_empty" \
              wget -q -S --no-config -t 1 --max-redirect=0 -T 15 -O - "$cur_url"
            ;;
          *)
            run_wget_capped "$out" "$cap" "$rc_file" "$hdr_file" "$rc_empty" \
              wget -q -S -t 1 --max-redirect=0 -T 15 -O - "$cur_url"
            ;;
        esac
        wget_rc=$(cat "$rc_file" 2>/dev/null || echo 1)
        loc=$(wget_last_location "$hdr_file")
        if [ -n "$loc" ] && grep -qiE '^[[:space:]]*HTTP/[0-9.]+[[:space:]]+30[12378]\b' "$hdr_file"; then
          hops=$((hops + 1))
          [ "$hops" -le 5 ] || err "too many redirects while downloading $url"
          cur_url=$(resolve_redirect_url "$cur_url" "$loc" "$scheme")
          continue
        fi
        break
      done
      check_wget_redirects "$hdr_file" "$scheme" "$url"
    else
      case "$wget_help" in
        *-S*)
          run_wget_capped "$out" "$cap" "$rc_file" "$hdr_file" "$rc_empty" \
            wget -q -S -T 15 -O - "$url"
          ;;
        *)
          [ "$scheme" != "https" ] || err "wget lacks -S to verify HTTPS-only redirects; install curl"
          run_wget_capped "$out" "$cap" "$rc_file" "$hdr_file" "$rc_empty" \
            wget -q -T 15 -O - "$url"
          ;;
      esac
      wget_rc=$(cat "$rc_file" 2>/dev/null || echo 1)
      check_wget_redirects "$hdr_file" "$scheme" "$url"
    fi
    size=$(wc -c < "$out" | tr -d ' ')
    [ "$size" -le "$cap" ] || err "$url exceeds maximum size ($cap bytes)"
    [ "$wget_rc" = "0" ] || err "failed to download $url"
    [ "$size" -gt 0 ] || err "empty response from $url"
    return 0
  else
    err "curl or wget is required to download ${SLUG}"
  fi
  size=$(wc -c < "$out" | tr -d ' ')
  [ "$size" -gt 0 ] || err "empty response from $url"
  [ "$size" -le "$cap" ] || err "$url exceeds maximum size ($cap bytes)"
}

lookup_sum() {
  sums_file="$1"
  target_name="$2"
  awk -v want="$target_name" '
    {
      sub(/\r$/, "")
      if (match($0, /^[0-9a-fA-F]{64} [ *]/)) {
        hash = tolower(substr($0, 1, 64))
        name = substr($0, 67)
        if (name == want) {
          print hash
          exit
        }
      }
    }
  ' "$sums_file"
}

detect_platform

REPO="${VELDR_GITHUB_REPO:-$DEFAULT_REPO}"
GITHUB_URL="${VELDR_GITHUB_URL:-https://github.com}"
GITHUB_URL="${GITHUB_URL%/}"

if [ -n "${VELDR_RELEASE_URL:-}" ]; then
  BASE_URL="${VELDR_RELEASE_URL%/}"
elif [ -n "$TAG" ]; then
  BASE_URL="${GITHUB_URL}/${REPO}/releases/download/${TAG}"
else
  BASE_URL="${GITHUB_URL}/${REPO}/releases/latest/download"
fi

ARCHIVE="${SLUG}-${PLATFORM}.tar.gz"
MEMBER="${SLUG}-${PLATFORM}/${SLUG}"

umask 077
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/${SLUG}-install.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
  [ -z "${STAGED_DEST:-}" ] || rm -f "$STAGED_DEST"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

SUMS_FILE="$TMP_DIR/SHA256SUMS"
ARCHIVE_FILE="$TMP_DIR/$ARCHIVE"
EXTRACTED_BIN="$TMP_DIR/$SLUG"

info "Fetching release manifest (${TAG:-latest}) for ${PLATFORM}"
fetch_file "${BASE_URL}/SHA256SUMS" "$SUMS_FILE" "$MAX_SUMS" 30

WANT_ARCHIVE=$(lookup_sum "$SUMS_FILE" "$ARCHIVE")
WANT_EXE=$(lookup_sum "$SUMS_FILE" "$MEMBER")
[ -n "$WANT_ARCHIVE" ] || err "SHA256SUMS at ${BASE_URL} has no archive entry for ${ARCHIVE} (is a ${SLUG} release published for ${TAG:-latest}?)"
[ -n "$WANT_EXE" ] || err "SHA256SUMS at ${BASE_URL} has no executable entry for ${MEMBER}"

info "Downloading ${ARCHIVE}"
fetch_file "${BASE_URL}/${ARCHIVE}" "$ARCHIVE_FILE" "$MAX_ARCHIVE" 300

GOT_ARCHIVE=$(sha256_file "$ARCHIVE_FILE")
[ "$GOT_ARCHIVE" = "$WANT_ARCHIVE" ] || err "${ARCHIVE} SHA-256 mismatch: got ${GOT_ARCHIVE}, expected ${WANT_ARCHIVE}"

info "Verifying and installing ${SLUG} to ${INSTALL_DIR}"
gunzip -c "$ARCHIVE_FILE" | tar -xf - -O "$MEMBER" > "$EXTRACTED_BIN" || err "failed to extract ${MEMBER} from ${ARCHIVE}"

GOT_EXE=$(sha256_file "$EXTRACTED_BIN")
[ "$GOT_EXE" = "$WANT_EXE" ] || err "extracted ${SLUG} SHA-256 mismatch: got ${GOT_EXE}, expected ${WANT_EXE}"

mkdir -p "$INSTALL_DIR"
STAGED_DEST=$(mktemp "$INSTALL_DIR/.${SLUG}.XXXXXX")
cat "$EXTRACTED_BIN" > "$STAGED_DEST"
chmod 755 "$STAGED_DEST"
mv -f "$STAGED_DEST" "$INSTALL_DIR/$SLUG"
STAGED_DEST=""

installed_ver=$("$INSTALL_DIR/$SLUG" version 2>/dev/null || echo "$SLUG")
info "Installed ${installed_ver} at ${INSTALL_DIR}/${SLUG}"

case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    printf '\nAdd %s to your PATH to run `%s` from anywhere:\n' "$INSTALL_DIR" "$SLUG"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac
