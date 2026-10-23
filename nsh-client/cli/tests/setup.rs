#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
    bin: PathBuf,
    archive: PathBuf,
    downloads: PathBuf,
    asset: String,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("checkout with spaces");
        let bin = temp.path().join("bin");
        let sdk = temp.path().join("fixture/nsh");
        for dir in [
            root.join("native-host"),
            bin.clone(),
            sdk.join("bin"),
            sdk.join("embed/android"),
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(
            root.join("native-host/Cargo.toml"),
            "[dependencies]\nnsh-platform-macos = { version = \"=0.2.0\" }\n",
        )
        .unwrap();
        let nsh = sdk.join("bin/nsh");
        fs::write(&nsh, "#!/bin/sh\necho 'nsh 0.2.0 (fixture)'\n").unwrap();
        fs::set_permissions(nsh, fs::Permissions::from_mode(0o755)).unwrap();
        for file in ["nsh.aar", "nsh-dev.aar"] {
            fs::write(sdk.join("embed/android").join(file), []).unwrap();
        }
        let archive = temp.path().join("fixture.tar.gz");
        assert!(
            Command::new("tar")
                .arg("-czf")
                .arg(&archive)
                .arg("-C")
                .arg(sdk.parent().unwrap())
                .arg("nsh")
                .status()
                .unwrap()
                .success()
        );
        let asset = if cfg!(target_os = "macos") {
            "nsh-macos-arm64.tar.gz"
        } else {
            "nsh-linux-x86_64.tar.gz"
        }
        .to_owned();
        let hash = Sha256::digest(fs::read(&archive).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        fs::write(
            root.join("nsh-toolchain.sha256"),
            format!("{hash}  {asset}\n"),
        )
        .unwrap();
        let curl = bin.join("curl");
        fs::write(&curl, "#!/bin/sh\necho download >> \"$TEST_DOWNLOADS\"\nsleep 0.2\nwhile [ \"$#\" -gt 0 ]; do\n if [ \"$1\" = --output ]; then cp \"$TEST_ARCHIVE\" \"$2\"; exit; fi\n shift\ndone\nexit 1\n").unwrap();
        fs::set_permissions(curl, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            root,
            bin,
            archive,
            asset,
            cache: temp.path().join("cache"),
            downloads: temp.path().join("downloads"),
            _temp: temp,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nsh-client-cli"));
        let paths = env::join_paths(
            std::iter::once(self.bin.clone())
                .chain(env::split_paths(&env::var_os("PATH").unwrap())),
        )
        .unwrap();
        command
            .arg("setup")
            .current_dir(&self.root)
            .env("XDG_CACHE_HOME", &self.cache)
            .env("PATH", paths)
            .env("TEST_ARCHIVE", &self.archive)
            .env("TEST_DOWNLOADS", &self.downloads)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

#[test]
fn concurrent_install_downloads_once_and_reuses_cache_without_network() {
    let fixture = Fixture::new();
    let first = fixture.command().spawn().unwrap();
    let second = fixture.command().spawn().unwrap();
    for process in [first, second] {
        let output = process.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        fs::read_to_string(&fixture.downloads)
            .unwrap()
            .lines()
            .count(),
        1
    );
    fs::write(fixture.bin.join("curl"), "#!/bin/sh\nexit 99\n").unwrap();
    fs::remove_file(fixture.root.join(".nsh/toolchain")).unwrap();
    assert!(fixture.command().status().unwrap().success());
    assert!(fixture.root.join(".nsh/toolchain/bin/nsh").is_file());
}

#[test]
fn corrupt_download_leaves_no_install_and_next_attempt_can_acquire_lock() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("nsh-toolchain.sha256"),
        format!("{}  {}\n", "0".repeat(64), fixture.asset),
    )
    .unwrap();
    for _ in 0..2 {
        let output = fixture.command().output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("SHA-256 mismatch"));
    }
    assert!(!fixture.root.join(".nsh/toolchain").exists());
    let version_dir = fixture.cache.join("chrome-acp/nsh/0.2.0");
    assert!(
        fs::read_dir(version_dir)
            .unwrap()
            .all(|entry| entry.unwrap().path().is_file())
    );
}
