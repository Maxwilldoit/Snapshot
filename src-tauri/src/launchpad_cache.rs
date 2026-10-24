//! 可丢弃的本机应用缓存；扫描锁与读取锁分开，后台刷新不阻塞已有清单。
use crate::launchpad::InstalledApp;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize)]
struct DiskCatalog {
    version: u32,
    apps: Vec<InstalledApp>,
}

#[derive(Default)]
struct Snapshot {
    apps: Option<Vec<InstalledApp>>,
    refreshed: Option<Instant>,
}

pub(crate) struct CatalogCache {
    path: PathBuf,
    snapshot: Mutex<Snapshot>,
    scan: Mutex<()>,
}

impl CatalogCache {
    pub(crate) fn new(path: PathBuf) -> Self {
        let apps = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DiskCatalog>(&bytes).ok())
            .filter(|cache| cache.version == 1)
            .map(|cache| cache.apps);
        Self {
            path,
            snapshot: Mutex::new(Snapshot {
                apps,
                refreshed: None,
            }),
            scan: Mutex::new(()),
        }
    }

    pub(crate) fn cached(&self) -> Option<Vec<InstalledApp>> {
        self.snapshot.lock().apps.clone()
    }

    pub(crate) fn get_or_scan(
        &self,
        scan: impl FnOnce() -> Vec<InstalledApp>,
    ) -> Vec<InstalledApp> {
        if let Some(apps) = self.cached() {
            return apps;
        }
        self.refresh(scan)
    }

    pub(crate) fn refresh(&self, scan: impl FnOnce() -> Vec<InstalledApp>) -> Vec<InstalledApp> {
        // 冷启动、预加载和同时到来的请求共用一次扫描；空清单也算有效结果。
        let _guard = self.scan.lock();
        {
            let snapshot = self.snapshot.lock();
            if snapshot
                .refreshed
                .is_some_and(|time| time.elapsed() < REFRESH_INTERVAL)
            {
                return snapshot.apps.clone().unwrap_or_default();
            }
        }
        let apps = scan();
        *self.snapshot.lock() = Snapshot {
            apps: Some(apps.clone()),
            refreshed: Some(Instant::now()),
        };
        let stored = DiskCatalog {
            version: 1,
            apps: apps.clone(),
        };
        // 原子替换，缓存损坏或无法写入不影响启动；下次退回后台扫描。
        let persist = || -> Result<(), Box<dyn std::error::Error>> {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let temporary = self.path.with_extension("json.tmp");
            fs::write(&temporary, serde_json::to_vec(&stored)?)?;
            fs::rename(temporary, &self.path)?;
            Ok(())
        };
        if let Err(error) = persist() {
            eprintln!("snapshot: could not cache launchpad catalog: {error}");
        }
        apps
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
            Self(std::env::temp_dir().join(format!(
                    "snapshot-launch-cache-{}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    SEQUENCE.fetch_add(1, Ordering::Relaxed)
                )))
        }
        fn cache(&self) -> CatalogCache {
            CatalogCache::new(self.0.join("catalog.json"))
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn entry(id: &str) -> InstalledApp {
        InstalledApp {
            id: id.into(),
            name: id.into(),
            target: format!("{id}.lnk"),
            listed: true,
        }
    }

    /// 手动测量真实系统扫描与缓存读取，不把机器快慢写成测试阈值。
    #[test]
    #[ignore]
    fn measure_local_catalog_cache() {
        let dir = TestDir::new();
        let cache = dir.cache();
        let start = Instant::now();
        let apps = cache.get_or_scan(crate::os::installed_apps);
        let cold = start.elapsed();
        let start = Instant::now();
        let warm = cache.get_or_scan(|| panic!("must use memory cache"));
        let memory = start.elapsed();
        let start = Instant::now();
        let restored = dir.cache().get_or_scan(|| panic!("must use disk cache"));
        let disk = start.elapsed();
        assert_eq!(apps.len(), warm.len());
        assert_eq!(apps.len(), restored.len());
        println!(
            "apps={}, scan={cold:?}, memory={memory:?}, disk={disk:?}",
            apps.len()
        );
    }

    #[test]
    fn restart_reuses_disk_then_refreshes_added_and_removed_apps() {
        let dir = TestDir::new();
        dir.cache().refresh(|| vec![entry("old")]);
        let cache = dir.cache();
        assert_eq!(
            cache.get_or_scan(|| panic!("cached reads must not scan"))[0].id,
            "old"
        );
        cache.refresh(|| vec![entry("new")]);
        assert_eq!(cache.cached().unwrap()[0].id, "new");
        assert_eq!(dir.cache().cached().unwrap()[0].id, "new");
    }

    #[test]
    fn concurrent_cold_requests_share_one_scan_even_for_an_empty_catalog() {
        let dir = TestDir::new();
        let cache = Arc::new(dir.cache());
        let scans = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let (cache, scans, barrier) = (cache.clone(), scans.clone(), barrier.clone());
                scope.spawn(move || {
                    barrier.wait();
                    assert!(cache
                        .get_or_scan(|| {
                            scans.fetch_add(1, Ordering::Relaxed);
                            vec![]
                        })
                        .is_empty());
                });
            }
        });
        assert_eq!(scans.load(Ordering::Relaxed), 1);
        cache.refresh(|| panic!("rapid opens must not rescan"));
        assert_eq!(dir.cache().cached().unwrap().len(), 0);
    }

    #[test]
    fn cached_reads_do_not_wait_for_a_background_scan() {
        let dir = TestDir::new();
        dir.cache().refresh(|| vec![entry("old")]);
        let cache = dir.cache();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let cache_ref = &cache;
            scope.spawn(move || {
                cache_ref.refresh(|| {
                    started_tx.send(()).unwrap();
                    finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    vec![entry("new")]
                })
            });
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(cache.get_or_scan(|| panic!("already cached"))[0].id, "old");
            finish_tx.send(()).unwrap();
        });
        assert_eq!(cache.cached().unwrap()[0].id, "new");
    }

    #[test]
    fn corrupt_and_unknown_cache_versions_fall_back_to_scan() {
        let dir = TestDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        for bytes in [
            b"broken".as_slice(),
            br#"{"version":999,"apps":[]}"#.as_slice(),
        ] {
            fs::write(dir.0.join("catalog.json"), bytes).unwrap();
            let cache = dir.cache();
            assert!(cache.cached().is_none());
            assert_eq!(cache.get_or_scan(|| vec![entry("found")])[0].id, "found");
        }
    }
}
