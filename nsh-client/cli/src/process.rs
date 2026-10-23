use std::process::{Child, Command};

use anyhow::{Context, Result, ensure};

pub fn run(command: &mut Command) -> Result<()> {
    let status = command
        .status()
        .with_context(|| format!("Cannot start {command:?}"))?;
    ensure!(status.success(), "Command failed ({status}): {command:?}");
    Ok(())
}

pub fn output(command: &mut Command) -> Result<String> {
    let result = command
        .output()
        .with_context(|| format!("Cannot start {command:?}"))?;
    ensure!(
        result.status.success(),
        "Command failed: {command:?}\n{}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}

/// Own spawned processes so errors and Ctrl-C also terminate them.
pub struct ChildGuard(pub Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
