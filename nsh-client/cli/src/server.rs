use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};

use crate::{process::ChildGuard, toolchain::Toolchain};

pub struct Server {
    pub child: ChildGuard,
    pub port: u16,
}

fn announced_port(line: &str) -> Option<u16> {
    line.split("dev server ws://127.0.0.1:")
        .nth(1)?
        .split('/')
        .next()?
        .parse()
        .ok()
}

fn forward(stream: impl Read + Send + 'static, log: Arc<Mutex<File>>, ports: mpsc::Sender<u16>) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            println!("{line}");
            if let Ok(mut log) = log.lock() {
                let _ = writeln!(log, "{line}");
            }
            if let Some(port) = announced_port(&line) {
                let _ = ports.send(port);
            }
        }
    });
}

pub fn start(
    root: &Path,
    sdk: &Toolchain,
    platform: &str,
    port: u16,
    cancelled: &AtomicBool,
) -> Result<Server> {
    fs::create_dir_all(root.join(".nsh"))?;
    let log_path = root.join(format!(".nsh/{platform}-dev.log"));
    let log = Arc::new(Mutex::new(File::create(&log_path)?));
    let mut child = ChildGuard(
        Command::new(sdk.executable())
            .arg("dev")
            .arg(root)
            .args(["--server-only", "--port", &port.to_string()])
            .env("NSH_RUNTIME", sdk.home.join("runtime"))
            .env("NO_COLOR", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Cannot start NSH dev server")?,
    );
    let (sender, receiver) = mpsc::channel();
    forward(child.0.stdout.take().unwrap(), log.clone(), sender.clone());
    forward(child.0.stderr.take().unwrap(), log, sender);
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if cancelled.load(Ordering::Relaxed) {
            bail!("Interrupted while starting NSH dev server");
        }
        if let Ok(port) = receiver.recv_timeout(Duration::from_millis(100)) {
            return Ok(Server { child, port });
        }
        if let Some(status) = child.0.try_wait()? {
            bail!(
                "NSH dev server exited ({status}); see {}",
                log_path.display()
            );
        }
        if Instant::now() >= deadline {
            bail!(
                "NSH dev server did not become ready; see {}",
                log_path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_actual_port_when_requested_port_is_busy() {
        assert_eq!(
            announced_port("→ dev server ws://127.0.0.1:8795/ws"),
            Some(8795)
        );
        assert_eq!(
            announced_port("devices on this network: ws://192.168.1.2:8795/ws"),
            None
        );
    }
}
