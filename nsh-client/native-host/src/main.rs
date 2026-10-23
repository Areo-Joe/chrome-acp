use std::path::Path;

use nsh_platform_macos::{AppOptions, AppSource, Bundle, run_app};

fn main() -> std::process::ExitCode {
    nsh_platform_macos::dev::init_logging();
    let source = if let Some(url) = std::env::args().nth(1) {
        AppSource::DevServer(url)
    } else {
        // Load source to avoid exchanging bytecode between CLI and local runtime versions.
        let bundle_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.nsh/out/bundle.js");
        let bundle = match Bundle::read(&bundle_path) {
            Ok(bundle) => bundle,
            Err(error) => {
                eprintln!(
                    "Cannot load {}: {error}. Run just macos",
                    bundle_path.display()
                );
                return std::process::ExitCode::FAILURE;
            }
        };
        AppSource::Bundle(bundle)
    };
    run_app(
        source,
        AppOptions {
            title: "NSH Client".into(),
            app_id: "com.chrome-acp.nsh-client".into(),
            size: (560, 680),
            ..AppOptions::default()
        },
    )
}
