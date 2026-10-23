use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use sha2::{Digest, Sha256};

use crate::process;

pub struct Toolchain {
    pub home: PathBuf,
}

impl Toolchain {
    pub fn executable(&self) -> PathBuf {
        self.home.join("bin/nsh")
    }
}

fn pinned_version(root: &Path) -> Result<String> {
    let manifest: toml::Value =
        toml::from_str(&fs::read_to_string(root.join("native-host/Cargo.toml"))?)?;
    let value = manifest
        .get("dependencies")
        .and_then(|v| v.get("nsh-platform-macos"))
        .and_then(|v| v.get("version"))
        .and_then(toml::Value::as_str)
        .context("Missing nsh-platform-macos version")?;
    let version = value
        .strip_prefix('=')
        .context("Pin nsh-platform-macos with an exact =version")?;
    ensure!(
        version.split('.').count() == 3
            && version
                .split('.')
                .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        "Invalid NSH version: {version}"
    );
    Ok(version.to_owned())
}

fn checksum(root: &Path, asset: &str) -> Result<String> {
    fs::read_to_string(root.join("nsh-toolchain.sha256"))?
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let digest = fields.next()?;
            (fields.next()? == asset
                && digest.len() == 64
                && digest.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| digest.to_ascii_lowercase())
        })
        .with_context(|| format!("Missing checksum for {asset}"))
}

fn has_sdk(home: &Path) -> bool {
    [
        "bin/nsh",
        "embed/android/nsh.aar",
        "embed/android/nsh-dev.aar",
    ]
    .iter()
    .all(|p| home.join(p).is_file())
}

fn verify_archive(archive: &Path, expected: &str) -> Result<()> {
    let mut input = File::open(archive)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    ensure!(
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            == expected,
        "NSH archive SHA-256 mismatch; refusing to install"
    );
    Ok(())
}

pub fn prepare(root: &Path, cancelled: &AtomicBool) -> Result<Toolchain> {
    let target = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("linux", "x86_64") => "linux-x86_64",
        _ => bail!("Supported development machines: Apple Silicon macOS and x86_64 Linux"),
    };
    let version = pinned_version(root)?;
    let asset = format!("nsh-{target}.tar.gz");
    let digest = checksum(root, &asset)?;
    let base = env::var_os("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or(
        PathBuf::from(env::var_os("HOME").context("HOME is not set")?).join(
            if cfg!(target_os = "macos") {
                "Library/Caches"
            } else {
                ".cache"
            },
        ),
    );
    let parent = base.join("chrome-acp/nsh").join(&version);
    fs::create_dir_all(&parent)?;
    let cache = parent.join(format!("{target}-{digest}"));
    // Kernel-owned locks are released even if the setup process is killed.
    let guard = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(cache.with_extension("lock"))?;
    loop {
        match guard.try_lock_exclusive() {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                ensure!(
                    !cancelled.load(Ordering::Relaxed),
                    "Interrupted while waiting for NSH setup"
                );
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.into()),
        }
    }
    let marker = format!("{version} {digest}");
    let ready = cache.join(".verified");
    // Preserve caches written by the earlier setup implementation.
    if !ready.exists()
        && has_sdk(&cache)
        && let Ok(old) = fs::read_to_string(cache.join(".verified.json"))
        && old.contains(&format!("\"version\": \"{version}\""))
        && old.contains(&format!("\"sha256\": \"{digest}\""))
    {
        fs::write(&ready, &marker)?;
    }
    let valid = fs::read_to_string(&ready).is_ok_and(|s| s.trim() == marker) && has_sdk(&cache);
    if !valid {
        ensure!(
            !cache.exists(),
            "Incomplete NSH cache: remove {} and retry",
            cache.display()
        );
        let work = tempfile::Builder::new()
            .prefix(".download-")
            .tempdir_in(&parent)?;
        let archive = work.path().join(&asset);
        let url = format!("https://github.com/longbridge/nsh/releases/download/v{version}/{asset}");
        println!("Downloading NSH {version}: {url}");
        process::run(
            Command::new("curl")
                .args(["--fail", "--location", "--retry", "3", "--output"])
                .arg(&archive)
                .arg(url),
        )?;
        verify_archive(&archive, &digest)?;
        process::run(
            Command::new("tar")
                .args(["-xzf"])
                .arg(&archive)
                .arg("-C")
                .arg(work.path()),
        )?;
        let extracted = work.path().join("nsh");
        ensure!(
            has_sdk(&extracted),
            "NSH archive is missing its CLI or Android SDKs"
        );
        let actual = process::output(Command::new(extracted.join("bin/nsh")).arg("--version"))?;
        ensure!(
            actual
                .split_whitespace()
                .take(2)
                .eq(["nsh", version.as_str()]),
            "NSH CLI version mismatch: {actual}"
        );
        fs::write(extracted.join(".verified"), &marker)?;
        fs::rename(extracted, &cache)?;
    }
    let local = root.join(".nsh");
    fs::create_dir_all(&local)?;
    let temporary = tempfile::Builder::new()
        .prefix(".link-")
        .tempdir_in(&local)?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&cache, temporary.path().join("toolchain"))?;
    #[cfg(not(unix))]
    bail!("This toolchain requires a Unix development machine");
    fs::rename(temporary.path().join("toolchain"), local.join("toolchain"))?;
    let stamp = local.join("toolchain-ready");
    let cache_name = cache.to_string_lossy();
    if fs::read_to_string(&stamp).ok().as_deref() != Some(cache_name.as_ref()) {
        File::create(&stamp)?.write_all(cache_name.as_bytes())?;
    }
    println!("NSH {version} ready: {}", local.join("toolchain").display());
    Ok(Toolchain {
        home: local.join("toolchain"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_archive_is_rejected() {
        let work = tempfile::tempdir().unwrap();
        let file = work.path().join("archive");
        fs::write(&file, b"corrupt download").unwrap();
        assert!(verify_archive(&file, &"0".repeat(64)).is_err());
    }
}
