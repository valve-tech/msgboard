// Loads the prebuilt native addon for the current platform. The `.node` files are build artifacts
// (gitignored) — built by `cargo build --release --features napi` + copied to
// `pow-grinder.<platform>-<arch>.node` (see scripts/build-native.sh); CI builds the linux one.
const { platform, arch } = process
const candidates = [`./pow-grinder.${platform}-${arch}.node`, './pow-grinder.node']

let binding
let lastErr
for (const c of candidates) {
  try {
    binding = require(c)
    break
  } catch (e) {
    lastErr = e
  }
}
if (!binding) {
  throw new Error(
    `@msgboard/pow-grinder: no native addon for ${platform}-${arch}. ` +
      `The published package ships the portable WASM engine, not a native prebuild — ` +
      `import '@msgboard/pow-grinder/wasm' for the cross-platform stamp (or build a native addon ` +
      `with 'npm run build:native'). Last error: ${lastErr && lastErr.message}`,
  )
}

// stamp(category: Buffer[32], data: Buffer, workMultiplier, workDivisor, blockHash: Buffer[32],
//       startNonce, maxIters) -> Buffer(40) = nonce_be(8) ‖ hash(32), or null.
module.exports = { stamp: binding.stamp }
