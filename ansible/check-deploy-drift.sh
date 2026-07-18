#!/usr/bin/env bash
# Report which services deployed on the msgboard box have drifted from the local checkout.
#
# For each service it compares a content hash (source files, excluding node_modules/dist) of the
# package on the box (/opt/msgboard/packages/<svc>) against the same package in this repo. Run it from
# a checkout at the revision you intend to deploy (e.g. master) to see what needs (re)deploying.
#
#   MSGBOARD_BOX_KEY=/path/to/msgboard_faucet_box ansible/check-deploy-drift.sh
#
# Exit code: 0 always; prints STALE / CURRENT / MISSING per service. safe-indexer is NOT listed here —
# its source lives in the gitignored deploy/ dir, so it cannot be compared against a git checkout.
set -uo pipefail
BOX="${MSGBOARD_BOX:-root@88.99.62.98}"
KEY="${MSGBOARD_BOX_KEY:-$HOME/.ssh/msgboard_faucet_box}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES=(cosign-web cosign-archive cosign-relay ui)

sshbox() { ssh -o IdentityAgent=none -o IdentitiesOnly=yes -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$BOX" "$@"; }
# hash a package dir relative to its own root so box vs local paths line up; SHA-256 both ends
hash_local() { ( cd "$REPO_ROOT/packages/$1" 2>/dev/null && find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*' | LC_ALL=C sort | xargs shasum -a 256 2>/dev/null | shasum -a 256 | cut -d' ' -f1 ) ; }
hash_box()   { sshbox "cd /opt/msgboard/packages/$1 2>/dev/null && find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*' | LC_ALL=C sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1" ; }

echo "service         status    (repo=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null))"
for svc in "${SERVICES[@]}"; do
  l="$(hash_local "$svc")"; b="$(hash_box "$svc")"
  if [ -z "$l" ]; then printf '%-15s %s\n' "$svc" "MISSING-LOCAL"; continue; fi
  if [ -z "$b" ]; then printf '%-15s %s\n' "$svc" "MISSING-ON-BOX"; continue; fi
  if [ "$l" = "$b" ]; then printf '%-15s %s\n' "$svc" "CURRENT"; else printf '%-15s %s  local:%s box:%s\n' "$svc" "STALE" "${l:0:12}" "${b:0:12}"; fi
done
