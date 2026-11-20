#!/bin/bash
# Builds a Lounge release from the last commit: lounge-<version>.tar.gz, and signs it if you
# give it the release key. The box's updater only installs releases signed with that key.
#
#   tools/make-release.sh [--key PATH/lounge-release] [--out DIR]
#
# It refuses to build if anything personal looks like it slipped in: VPN private keys,
# box data files, tokens, or any line from your own list of private words in
# ~/.config/lounge/private-patterns (one regular expression per line; that file is never
# in the repo).
#
# Publishing (GitHub): push the cleaned tree as one commit to the public repo, make a release
# called v<version>, and attach lounge-<version>.tar.gz and lounge-<version>.tar.gz.sig.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY=""
OUT="$ROOT/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(sed -n 's/^VERSION = "\([^"]*\)"/\1/p' "$ROOT/backend/lounged.py")"
[ -n "$VERSION" ] || { echo "no VERSION in backend/lounged.py" >&2; exit 1; }
NAME="lounge-$VERSION.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# autocrlf off: Git for Windows would otherwise write CRLF line endings into the archive,
# and the box's shell scripts and Python don't run with those.
git -C "$ROOT" -c core.autocrlf=false -c core.eol=lf archive --format=tar --prefix=Lounge/ HEAD \
  | tar -x -C "$STAGE"
rm -rf "$STAGE/Lounge/dist"
# The public repo is only how boxes get updates, not a project page: the README and the roadmap
# stay in the private repo (the release notes are written from ROADMAP.md when publishing)
rm -f "$STAGE/Lounge/README.md" "$STAGE/Lounge/ROADMAP.md" "$STAGE/Lounge/.gitignore"
if grep -rIl $'\r$' "$STAGE/Lounge" >/dev/null 2>&1; then
  echo "Refusing: Windows (CRLF) line endings in:" >&2
  grep -rIl $'\r$' "$STAGE/Lounge" | sed "s|$STAGE/|  |" >&2
  exit 1
fi

# ---- privacy check
fail=0
check() {  # check <description> <grep -E pattern>
  local hits
  hits="$(grep -rIlE "$2" "$STAGE/Lounge" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "Refusing: $1 in:" >&2
    printf '  %s\n' "${hits//$STAGE\//}" >&2
    fail=1
  fi
}
check "a WireGuard private key" '^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{42,}'
check "an SSH/OpenSSH private key" 'BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY'
check "a Jellyfin or API token" '"(token|accessToken|AccessToken)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9]{16,}"'
for f in settings.json recents.json profiles.json; do
  if find "$STAGE/Lounge" -name "$f" -not -path "*/config/*" | grep -q .; then
    echo "Refusing: box data file $f is in the tree" >&2; fail=1
  fi
done
if find "$STAGE/Lounge" -name "*.conf" -path "*vpn*" | grep -q .; then
  echo "Refusing: VPN config files are in the tree" >&2; fail=1
fi
PATTERNS="${LOUNGE_PRIVATE_PATTERNS:-$HOME/.config/lounge/private-patterns}"
if [ -s "$PATTERNS" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] || [[ "$pat" == \#* ]] && continue
    check "one of your private words" "$pat"
  done < "$PATTERNS"
fi
[ "$fail" = 0 ] || exit 1

# ---- build and sign
mkdir -p "$OUT"
tar -C "$STAGE" --owner=0 --group=0 --sort=name -czf "$OUT/$NAME" Lounge
echo "Built $OUT/$NAME"
if [ -n "$KEY" ]; then
  rm -f "$OUT/$NAME.sig"
  ssh-keygen -q -Y sign -f "$KEY" -n lounge-update "$OUT/$NAME"
  ssh-keygen -Y verify -f "$ROOT/system/update/allowed_signers" -I lounge-release -n lounge-update \
    -s "$OUT/$NAME.sig" < "$OUT/$NAME" >/dev/null
  echo "Signed $OUT/$NAME.sig (checked against system/update/allowed_signers)"
fi
