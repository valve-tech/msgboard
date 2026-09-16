fn main() {
    // Only wire the Node-API addon linkage when building the native addon (the `napi` feature).
    // For the rlib / wasm builds this is a no-op.
    if std::env::var("CARGO_FEATURE_NAPI").is_ok() {
        napi_build::setup();
    }
}
