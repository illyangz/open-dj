fn main() {
    // `state.rs` reads CONVEX_URL via `option_env!` at compile time — without
    // this, Cargo has no way to know that crate depends on this env var, so
    // an unchanged state.rs (as between two release tags with no code diff
    // there) gets served straight from Swatinem/rust-cache with whatever
    // CONVEX_URL was baked in on the run that first compiled and cached it,
    // silently ignoring a since-corrected repo variable.
    println!("cargo:rerun-if-env-changed=CONVEX_URL");
    tauri_build::build()
}
