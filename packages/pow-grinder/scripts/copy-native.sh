#!/usr/bin/env bash
# Copy the freshly-built cdylib to the platform-named .node the loader (index.js) expects.
set -euo pipefail
cd "$(dirname "$0")/.."
PLAT=$(node -e "process.stdout.write(process.platform + '-' + process.arch)")
case "$(uname -s)" in
  Darwin) EXT=dylib ;;
  *) EXT=so ;;
esac
cp "target/release/libpow_grinder.${EXT}" "pow-grinder.${PLAT}.node"
echo "built pow-grinder.${PLAT}.node"
