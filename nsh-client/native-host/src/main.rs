use std::path::Path;

use nsh_platform_macos::{AppOptions, AppSource, Bundle, WindowDisplay, run_app};

fn main() -> std::process::ExitCode {
    nsh_platform_macos::dev::init_logging();
    let mut options = AppOptions {
        title: "NSH Client".into(),
        app_id: "com.chrome-acp.nsh-client".into(),
        size: (560, 680),
        ..AppOptions::default()
    };
    // Accept the NSH test host's standard launch arguments, so native tests
    // exercise our actual image bridge rather than a simulated host handler.
    let mut args = std::env::args().skip(1);
    let mut url = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dev-server" => url = args.next(),
            "--data-dir" => options.data_dir = args.next().map(std::path::PathBuf::from),
            "--window-size" => {
                if let Some((width, height)) = args
                    .next()
                    .as_deref()
                    .and_then(|value| value.split_once('x'))
                {
                    options.size = (width.parse().unwrap_or(560), height.parse().unwrap_or(680));
                }
            }
            "--display" => {
                options.display = args.next().map(|value| {
                    value
                        .parse::<usize>()
                        .ok()
                        .and_then(|index| index.checked_sub(1))
                        .map(WindowDisplay::Index)
                        .unwrap_or(WindowDisplay::Secondary)
                })
            }
            "-ApplePersistenceIgnoreState" => {
                args.next();
            }
            "--keep-window-size" => options.keep_size = true,
            value if value.starts_with("ws://") || value.starts_with("wss://") => url = Some(arg),
            _ => {}
        }
    }
    let source = if let Some(url) = url {
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
    options.host.handle("image.normalize", |call| {
        std::thread::spawn(move || {
            let result = nsh_client_image_codec::normalize(call.data());
            call.reply(result);
        });
    });
    run_app(source, options)
}
