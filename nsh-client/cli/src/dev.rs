use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use anyhow::{Context, Result, ensure};

use crate::{
    process::{self, ChildGuard},
    server,
    toolchain::Toolchain,
};

pub fn macos(root: &Path, sdk: &Toolchain, cancelled: Arc<AtomicBool>) -> Result<()> {
    ensure!(cfg!(target_os = "macos"), "The macOS host requires macOS");
    // Explicit output directory also works with a user's custom CARGO_TARGET_DIR.
    let target = root.join(".nsh/macos-target");
    process::run(
        Command::new("cargo")
            .args(["+stable", "build", "--manifest-path"])
            .arg(root.join("native-host/Cargo.toml"))
            .arg("--target-dir")
            .arg(&target)
            .arg("--locked"),
    )?;
    let app = root.join(".nsh/NshClient.app");
    let executable = app.join("Contents/MacOS/nsh-client-macos");
    fs::create_dir_all(executable.parent().unwrap())?;
    fs::copy(target.join("debug/nsh-client-macos"), &executable)?;
    fs::copy(
        root.join("native-host/Info.plist"),
        app.join("Contents/Info.plist"),
    )?;
    process::run(
        Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&app),
    )?;
    let mut server = server::start(root, sdk, "macos", 8790, &cancelled)?;
    let mut host = ChildGuard(
        Command::new(executable)
            .arg(format!("ws://127.0.0.1:{}/ws", server.port))
            .spawn()?,
    );
    while !cancelled.load(Ordering::Relaxed) {
        if let Some(status) = host.0.try_wait()? {
            ensure!(status.success(), "macOS host exited ({status})");
            break;
        }
        if let Some(status) = server.child.0.try_wait()? {
            anyhow::bail!("NSH dev server exited ({status})");
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

struct Android {
    adb: PathBuf,
    device: String,
    java_home: Option<PathBuf>,
    sdk_home: PathBuf,
    forwarded_port: Option<u16>,
    started: bool,
}

impl Android {
    fn new(device: Option<String>) -> Result<Self> {
        let sdk_home = env::var_os("ANDROID_HOME")
            .or_else(|| env::var_os("ANDROID_SDK_ROOT"))
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME").map(|p| {
                    PathBuf::from(p).join(if cfg!(target_os = "macos") {
                        "Library/Android/sdk"
                    } else {
                        "Android/Sdk"
                    })
                })
            })
            .context("Set ANDROID_HOME to the Android SDK")?;
        let adb = sdk_home.join("platform-tools/adb");
        ensure!(
            adb.is_file(),
            "ADB not found at {}; set ANDROID_HOME",
            adb.display()
        );
        let mut probe = Command::new(&adb);
        if let Some(device) = device
            .filter(|d| !d.is_empty())
            .or_else(|| env::var("ANDROID_SERIAL").ok())
        {
            probe.args(["-s", &device]);
        }
        let device = process::output(probe.arg("get-serialno"))?;
        let java_home = if cfg!(target_os = "macos") {
            Some(PathBuf::from(process::output(
                Command::new("/usr/libexec/java_home").args(["-v", "17"]),
            )?))
        } else {
            env::var_os("JAVA_HOME").map(PathBuf::from)
        };
        Ok(Self {
            adb,
            device,
            java_home,
            sdk_home,
            forwarded_port: None,
            started: false,
        })
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.adb);
        command.args(["-s", &self.device]);
        command
    }

    fn build_and_install(&self, root: &Path) -> Result<()> {
        let mut build = Command::new(root.join("android-host/gradlew"));
        build
            .arg("-p")
            .arg(root.join("android-host"))
            .args([":app:assembleDebug", "--console=plain"])
            .env("ANDROID_HOME", &self.sdk_home);
        if let Some(java) = &self.java_home {
            build.env("JAVA_HOME", java);
        }
        process::run(&mut build)?;
        process::run(
            self.command()
                .args(["install", "-r"])
                .arg(root.join("android-host/app/build/outputs/apk/debug/app-debug.apk")),
        )
    }

    fn launch(&mut self, port: u16) -> Result<()> {
        let port_arg = format!("tcp:{port}");
        process::run(self.command().args(["reverse", &port_arg, &port_arg]))?;
        self.forwarded_port = Some(port);
        // Clean up even if am start partially succeeds before returning an error.
        self.started = true;
        process::run(self.command().args([
            "shell",
            "am",
            "start",
            "-S",
            "-n",
            "com.chromeacp.nshclient/.MainActivity",
            "--es",
            "dev_server",
            &format!("ws://127.0.0.1:{port}/ws"),
        ]))
    }
}

impl Drop for Android {
    fn drop(&mut self) {
        if self.started {
            let _ = self
                .command()
                .args(["shell", "am", "force-stop", "com.chromeacp.nshclient"])
                .status();
        }
        if let Some(port) = self.forwarded_port {
            let _ = self
                .command()
                .args(["reverse", "--remove", &format!("tcp:{port}")])
                .status();
        }
    }
}

pub fn android(
    root: &Path,
    sdk: &Toolchain,
    device: Option<String>,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    let mut android = Android::new(device)?;
    android.build_and_install(root)?;
    let mut server = server::start(root, sdk, "android", 8791, &cancelled)?;
    android.launch(server.port)?;
    while !cancelled.load(Ordering::Relaxed) {
        if let Some(status) = server.child.0.try_wait()? {
            anyhow::bail!("NSH dev server exited ({status})");
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
