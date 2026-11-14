//! Keep native move events independent of settings serialization and disk sync.
//! Only the latest position is saved, after movement has been quiet for 350 ms.

use crate::settings::PetPosition;
use parking_lot::Mutex;
use std::time::{Duration, Instant};

const QUIET: Duration = Duration::from_millis(350);

#[derive(Default)]
pub(crate) struct PositionPersistence {
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    latest: Option<(PetPosition, Instant)>,
    revision: u64,
    running: bool,
}

pub(crate) enum NextSave {
    Wait(Duration),
    Save {
        position: PetPosition,
        revision: u64,
    },
}

impl PositionPersistence {
    /// Returns true only when the caller needs to start a worker. This short
    /// lock never guards I/O or the application's settings lock.
    pub(crate) fn record(&self, position: PetPosition, now: Instant) -> bool {
        let mut pending = self.pending.lock();
        pending.latest = Some((position, now));
        pending.revision = pending.revision.wrapping_add(1);
        let start = !pending.running;
        pending.running = true;
        start
    }

    /// Copy a quiet position, then release the queue before acquiring settings
    /// or saving. New moves must remain writable even during a slow fsync.
    pub(crate) fn next(&self, now: Instant) -> NextSave {
        let pending = self.pending.lock();
        let (position, moved_at) = pending.latest.as_ref().expect("worker needs a position");
        let elapsed = now.saturating_duration_since(*moved_at);
        if elapsed < QUIET {
            NextSave::Wait(QUIET - elapsed)
        } else {
            NextSave::Save {
                position: position.clone(),
                revision: pending.revision,
            }
        }
    }

    /// Atomically finish or keep the worker for a move received while saving.
    /// Recording just after this returns true starts a fresh worker instead.
    pub(crate) fn complete(&self, revision: u64) -> bool {
        let mut pending = self.pending.lock();
        if revision != pending.revision {
            return false;
        }
        pending.running = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    fn position(x: i32) -> PetPosition {
        PetPosition { x, y: 200 }
    }

    fn ready(queue: &PositionPersistence, now: Instant) -> (PetPosition, u64) {
        match queue.next(now) {
            NextSave::Save { position, revision } => (position, revision),
            NextSave::Wait(_) => panic!("position should be ready to save"),
        }
    }

    #[test]
    fn continuous_dragging_never_saves_until_the_last_move_is_quiet() {
        let queue = PositionPersistence::default();
        let start = Instant::now();
        assert!(queue.record(position(0), start));
        for step in 1..=100 {
            let now = start + Duration::from_millis(step * 16);
            assert!(!queue.record(position(step as i32), now));
            assert!(matches!(queue.next(now), NextSave::Wait(QUIET)));
        }
        let last_move = start + Duration::from_millis(1600);
        assert!(matches!(
            queue.next(last_move + Duration::from_millis(349)),
            NextSave::Wait(remaining) if remaining == Duration::from_millis(1)
        ));
        let (saved, revision) = ready(&queue, last_move + QUIET);
        assert_eq!((saved.x, saved.y), (100, 200));
        assert!(queue.complete(revision));
        assert!(queue.record(position(101), last_move + QUIET));
    }

    #[test]
    fn a_slow_settings_save_does_not_block_moves_or_drop_the_latest_position() {
        let queue = Arc::new(PositionPersistence::default());
        let settings = Arc::new(Mutex::new(position(0)));
        let start = Instant::now();
        queue.record(position(10), start);
        let (save_started, started) = mpsc::channel();
        let (release_save, released) = mpsc::channel();
        let worker_queue = queue.clone();
        let worker_settings = settings.clone();
        let worker = std::thread::spawn(move || {
            let (value, revision) = ready(&worker_queue, start + QUIET);
            let mut stored = worker_settings.lock();
            *stored = value;
            save_started.send(()).unwrap();
            // Simulate disk sync while the settings writer holds its lock.
            released.recv_timeout(Duration::from_secs(2)).unwrap();
            worker_queue.complete(revision)
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(settings.try_lock().is_none());
        let (recorded, moved) = mpsc::channel();
        let moving_queue = queue.clone();
        let movement = std::thread::spawn(move || {
            let start_worker = moving_queue.record(position(500), start + QUIET);
            recorded.send(start_worker).unwrap();
        });
        // This would time out if a move acquired the settings/save lock.
        let result = moved.recv_timeout(Duration::from_millis(500));
        release_save.send(()).unwrap();
        assert!(!result.unwrap());
        movement.join().unwrap();
        assert!(!worker.join().unwrap());
        let (latest, revision) = ready(&queue, start + QUIET * 2);
        assert_eq!(latest.x, 500);
        assert!(queue.complete(revision));
    }
}
