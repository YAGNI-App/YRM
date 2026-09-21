fn main() {
    println!("yrm {} (placeholder release)", env!("CARGO_PKG_VERSION"));
    println!(
        "Real releases start at 0.1. Follow along: {}",
        env!("CARGO_PKG_REPOSITORY")
    );
}
