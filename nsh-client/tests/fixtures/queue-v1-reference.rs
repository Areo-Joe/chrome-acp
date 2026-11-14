// State machine copied from Zed 62682ebde9 conversation_view/message_queue.rs.
// GPUI-owned QueueEntry content/editors are reduced to text; queue logic is unchanged.
// Compile as a temporary Cargo binary with serde_json = "=1.0.151".
// Feed each queue-v1.json case's `commands` as one JSON line; output is `expected`.
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{self, BufRead};
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct QueueEntryId(usize);
pub struct QueueEntry {
    id: QueueEntryId,
    text: String,
    steer: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessingState {
    AutoProcess,
    Paused,
    // Sending a message out of turn cancelled the current generation; we must
    // absorb the Stopped event from that cancellation before resuming
    // auto-processing, otherwise the queue would double-send.
    AbsorbingCancel,
}

/// Holds follow-up messages typed while the agent is generating, along with
/// the state machine that decides when they're auto-sent.
pub struct MessageQueue {
    entries: VecDeque<QueueEntry>,
    processing_state: ProcessingState,
    can_fast_track: bool,
    next_id: usize,
}

impl Default for MessageQueue {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            processing_state: ProcessingState::AutoProcess,
            can_fast_track: false,
            next_id: 0,
        }
    }
}

impl MessageQueue {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn first(&self) -> Option<&QueueEntry> {
        self.entries.front()
    }

    pub fn first_id(&self) -> Option<QueueEntryId> {
        self.entries.front().map(|entry| entry.id)
    }

    pub fn last_id(&self) -> Option<QueueEntryId> {
        self.entries.back().map(|entry| entry.id)
    }

    /// Whether the next message should interrupt the agent at the next turn
    /// boundary. Drives the native thread's boundary flag.
    pub fn front_wants_steer(&self) -> bool {
        self.entries.front().is_some_and(|entry| entry.steer)
    }

    pub fn toggle_steer(&mut self, id: QueueEntryId) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) {
            entry.steer = !entry.steer;
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &QueueEntry> {
        self.entries.iter()
    }

    pub fn can_fast_track(&self) -> bool {
        self.can_fast_track && !self.entries.is_empty()
    }

    pub fn entry_by_id(&self, id: QueueEntryId) -> Option<&QueueEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    pub fn entry_by_id_mut(&mut self, id: QueueEntryId) -> Option<&mut QueueEntry> {
        self.entries.iter_mut().find(|entry| entry.id == id)
    }

    /// Allocates a stable ID for a new entry. This is separate from `enqueue`
    /// because the editor event subscription must capture the ID before the
    /// `QueueEntry` (which owns that subscription) can be constructed.
    pub fn next_id(&mut self) -> QueueEntryId {
        let id = QueueEntryId(self.next_id);
        self.next_id += 1;
        id
    }

    /// Queuing a message is active engagement, so it also resumes
    /// auto-processing if the queue was paused.
    pub fn enqueue(&mut self, entry: QueueEntry) {
        self.entries.push_back(entry);
        self.processing_state = ProcessingState::AutoProcess;
        self.can_fast_track = true;
    }

    pub fn remove(&mut self, id: QueueEntryId) -> Option<QueueEntry> {
        let index = self.entries.iter().position(|entry| entry.id == id)?;
        self.entries.remove(index)
    }

    pub fn restore_after_failed_send(&mut self, entry: QueueEntry) {
        let index = self
            .entries
            .iter()
            .position(|queued| queued.id.0 > entry.id.0)
            .unwrap_or(self.entries.len());
        self.entries.insert(index, entry);
        self.pause();
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.can_fast_track = false;
    }

    /// Pops the front entry if a fast-track send is allowed (the user just
    /// queued a message and pressed Enter on an empty main editor).
    ///
    /// This works even when paused — pressing Enter is an explicit user
    /// action, distinct from auto-processing. If a generation is in flight,
    /// the dispatch will cancel it, so we must absorb that cancellation's
    /// Stopped event to avoid double-sending the next entry.
    pub fn try_fast_track(&mut self, is_generating: bool) -> Option<QueueEntry> {
        if !self.can_fast_track {
            return None;
        }
        self.can_fast_track = false;
        let entry = self.entries.pop_front()?;
        self.processing_state = if is_generating {
            ProcessingState::AbsorbingCancel
        } else {
            ProcessingState::AutoProcess
        };
        Some(entry)
    }

    /// Handles a generation Stopped event, returning the entry to auto-send,
    /// if any.
    pub fn auto_send_candidate(&self, is_first_editor_focused: bool) -> Option<&QueueEntry> {
        if matches!(self.processing_state, ProcessingState::AutoProcess) && !is_first_editor_focused
        {
            self.entries.front()
        } else {
            None
        }
    }

    pub fn on_generation_stopped(&mut self, is_first_editor_focused: bool) -> Option<QueueEntry> {
        match self.processing_state {
            ProcessingState::AbsorbingCancel => {
                // This Stopped event came from a cancellation we initiated
                // ourselves (e.g. "Send Now"); swallow it and resume.
                self.processing_state = ProcessingState::AutoProcess;
                None
            }
            ProcessingState::Paused => None,
            ProcessingState::AutoProcess => {
                // Don't auto-send while the user is editing the next message.
                if self.auto_send_candidate(is_first_editor_focused).is_some() {
                    self.entries.pop_front()
                } else {
                    None
                }
            }
        }
    }

    /// Removes an entry for an explicit "Send Now". If a generation is in
    /// flight, the dispatch will cancel it, so we must absorb that
    /// cancellation's Stopped event.
    pub fn send_now(&mut self, id: QueueEntryId, is_generating: bool) -> Option<QueueEntry> {
        let entry = self.remove(id)?;
        if is_generating {
            self.processing_state = ProcessingState::AbsorbingCancel;
        }
        Some(entry)
    }

    /// Called when the user stops generation; queued messages stay put until
    /// the user re-engages.
    pub fn pause(&mut self) {
        self.processing_state = ProcessingState::Paused;
    }

    /// Called when the user sends a new message, re-enabling auto-processing.
    /// This is what un-freezes the queue after a manual stop.
    pub fn resume(&mut self) {
        self.processing_state = ProcessingState::AutoProcess;
    }
}

fn main() {
    for line in io::stdin().lock().lines() {
        let commands: Vec<Value> = serde_json::from_str(&line.unwrap()).unwrap();
        let mut q = MessageQueue::default();
        let mut snapshots = vec![];
        for c in commands {
            let id = QueueEntryId(c["id"].as_u64().unwrap_or(0) as usize);
            let flag = c["flag"].as_bool().unwrap_or(false);
            let result = match c["op"].as_str().unwrap() {
                "enqueue" => {
                    let entry = QueueEntry {
                        id: q.next_id(),
                        text: c["text"].as_str().unwrap().into(),
                        steer: false,
                    };
                    q.enqueue(entry);
                    None
                }
                "remove" => q.remove(id),
                "clear" => {
                    q.clear();
                    None
                }
                "pause" => {
                    q.pause();
                    None
                }
                "resume" => {
                    q.resume();
                    None
                }
                "fast" => q.try_fast_track(flag),
                "stopped" => q.on_generation_stopped(flag),
                "now" => q.send_now(id, flag),
                "restore" => {
                    q.restore_after_failed_send(QueueEntry {
                        id,
                        text: c["text"].as_str().unwrap().into(),
                        steer: false,
                    });
                    None
                }
                _ => panic!("bad command"),
            };
            let state = match q.processing_state {
                ProcessingState::AutoProcess => "auto",
                ProcessingState::Paused => "paused",
                ProcessingState::AbsorbingCancel => "absorbing-cancel",
            };
            snapshots.push(json!({"entries":q.iter().map(|e|json!({"id":e.id.0,"text":e.text})).collect::<Vec<_>>(),
   "processing":state,"fast":q.can_fast_track(),"result":result.map(|e|json!({"id":e.id.0,"text":e.text}))}));
        }
        println!("{}", json!(snapshots));
    }
}
