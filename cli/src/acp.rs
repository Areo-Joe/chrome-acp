use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub struct AppState {
    pub agent: Vec<String>,
    pub token: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if let Some(expected_token) = &state.token {
        let authorized = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|token| token == expected_token);

        if !authorized {
            return Err((StatusCode::UNAUTHORIZED, "Unauthorized".to_string()));
        }
    }

    let mut command = Command::new(&state.agent[0]);
    command.args(&state.agent[1..]);

    let mut child = command
        .process_group(0)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to spawn agent".to_string(),
            )
        })?;

    let Some(stdin) = child.stdin.take() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to take stdin from child process".into(),
        ));
    };

    let Some(stdout) = child.stdout.take() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to take stdout from child process".into(),
        ));
    };

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, (child, stdin, stdout))))
}

async fn handle_socket(
    socket: WebSocket,
    (child, mut stdin, stdout): (Child, ChildStdin, ChildStdout),
) {
    let (mut sender, mut receiver) = socket.split();
    let mut lines = BufReader::new(stdout).lines();

    let mut t1 = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            let Message::Text(text) = msg else {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
                continue;
            };

            let line = format!("{}\n", text.trim());
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });
    let mut t2 = tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if sender.send(Message::Text(line.into())).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut t1 => t2.abort(),
        _ = &mut t2 => t1.abort(),
    }

    if let Some(pid) = child.id() {
        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
    }
    drop(child);
}
