//! One official CYAPI route, chosen once and reused by every request.
//!
//! Startup probes Beijing, then Hong Kong, then the Cloudflare hostname and
//! remembers the first node that answers; normal requests then go through that
//! node only instead of retrying all three every time. A failed request
//! invalidates the choice, so the next request re-probes in the same order.
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::atomic::{AtomicU8, Ordering},
    time::Duration,
};

use reqwest::{blocking::Client, redirect::Policy, Url};

use super::Result;

pub(crate) const API_HOST: &str = "api.cyapi.cyou";
const PROBE_PATH: &str = "/api/cyapi-routes";
const BEIJING_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(101, 201, 221, 190));
const HONG_KONG_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(149, 104, 31, 54));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Beijing,
    HongKong,
    Cloudflare,
}

impl Route {
    /// Preference order: direct Beijing proxy, direct Hong Kong origin, then
    /// the public Cloudflare hostname.
    pub(crate) const ORDER: [Route; 3] = [Route::Beijing, Route::HongKong, Route::Cloudflare];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Beijing => "beijing",
            Self::HongKong => "hongkong",
            Self::Cloudflare => "cloudflare",
        }
    }

    /// Anonymous, user-facing name. The log and the UI never say which line is
    /// which, so a report can be shared without revealing the network layout.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Beijing => "线路一",
            Self::HongKong => "线路二",
            Self::Cloudflare => "线路三",
        }
    }

    /// The address that replaces DNS for a direct route. `None` keeps the
    /// normal resolution (and any system proxy) for the Cloudflare name.
    pub(crate) fn address(self) -> Option<IpAddr> {
        match self {
            Self::Beijing => Some(BEIJING_IP),
            Self::HongKong => Some(HONG_KONG_IP),
            Self::Cloudflare => None,
        }
    }

    /// Beijing is reached through the local tunnel proxy: the mainland entry
    /// filters any handshake that carries the official hostname, so the socket
    /// must be dialled through a second TLS layer instead of `resolve`.
    pub(crate) fn proxy(self) -> Option<String> {
        match self {
            Self::Beijing => crate::tunnel::proxy_url(),
            _ => None,
        }
    }

    pub(crate) fn next(self) -> Self {
        match self {
            Self::Beijing => Self::HongKong,
            Self::HongKong => Self::Cloudflare,
            Self::Cloudflare => Self::Beijing,
        }
    }

    fn slot(self) -> u8 {
        match self {
            Self::Beijing => 1,
            Self::HongKong => 2,
            Self::Cloudflare => 3,
        }
    }

    fn from_slot(slot: u8) -> Option<Self> {
        Self::ORDER.into_iter().find(|route| route.slot() == slot)
    }
}

/// Holds the node selected for this process. `0` means "not chosen yet".
pub(crate) struct RoutePriority {
    active: AtomicU8,
}

impl RoutePriority {
    pub(crate) const fn new() -> Self {
        Self {
            active: AtomicU8::new(0),
        }
    }

    pub(crate) fn current(&self) -> Option<Route> {
        Route::from_slot(self.active.load(Ordering::Relaxed))
    }

    /// Reuse the remembered node unless it is the one that just failed; only
    /// then probe the remaining routes in order.
    pub(crate) fn select(
        &self,
        avoid: Option<Route>,
        mut probe: impl FnMut(Route) -> bool,
    ) -> Option<Route> {
        if let Some(active) = self.current() {
            if Some(active) != avoid {
                return Some(active);
            }
        }
        for route in Route::ORDER {
            if Some(route) == avoid {
                continue;
            }
            crate::logging::event("info", "network", format!("尝试{}", route.label()));
            if probe(route) {
                self.active.store(route.slot(), Ordering::Relaxed);
                crate::logging::event(
                    "info",
                    "network",
                    format!("{}可用，后续请求沿用", route.label()),
                );
                return Some(route);
            }
            crate::logging::event(
                "warn",
                "network",
                format!("{}不可用，尝试下一条线路", route.label()),
            );
        }
        self.active.store(0, Ordering::Relaxed);
        None
    }

    pub(crate) fn demote(&self, route: Route) {
        // Only a failure of the current node clears the choice; a late failure
        // from a request that started on another node must not.
        let _ = self
            .active
            .compare_exchange(route.slot(), 0, Ordering::Relaxed, Ordering::Relaxed);
    }
}

// Shared by the platform API and every download, so the app talks to one node.
pub(crate) static PRIORITY: RoutePriority = RoutePriority::new();

/// Cheap unauthenticated probe: one short GET through the candidate route.
pub(crate) fn probe(route: Route) -> bool {
    let Ok(url) = Url::parse(&format!("https://{API_HOST}{PROBE_PATH}")) else {
        return false;
    };
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_millis(1_500))
        .timeout(Duration::from_secs(3))
        .redirect(Policy::none())
        .user_agent(format!("CYAPI-Toolbox/{}", env!("CARGO_PKG_VERSION")));
    if let Some(proxy) = route.proxy() {
        builder = match reqwest::Proxy::all(proxy) {
            Ok(proxy) => builder.proxy(proxy),
            Err(_) => return false,
        };
    } else if let Some(address) = route.address() {
        builder = builder
            .no_proxy()
            .resolve(API_HOST, SocketAddr::new(address, 443));
    }
    builder
        .build()
        .ok()
        .and_then(|client| {
            client
                .get(url)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .ok()
        })
        .is_some_and(|response| response.status().as_u16() < 500)
}

/// Warm the choice at app startup so the first user action does not wait for
/// a probe. Runs on a background thread.
pub(crate) fn warm() {
    let _ = PRIORITY.select(None, probe);
}

/// Try the remembered route once, and re-select before a single retry when the
/// node fails. `official` is false for hosts that must keep normal resolution.
pub(crate) fn fetch<T>(
    priority: &RoutePriority,
    official: bool,
    is_cancelled: impl Fn() -> bool,
    mut probe: impl FnMut(Route) -> bool,
    mut attempt: impl FnMut(Route, bool) -> Result<T>,
) -> Result<T> {
    if is_cancelled() {
        return Err(crate::cancel::MESSAGE.into());
    }
    let first = if official {
        priority
            .select(None, &mut probe)
            .unwrap_or(Route::Cloudflare)
    } else {
        // Other hosts are never redirected to the official origin.
        Route::Cloudflare
    };
    let first_error = match attempt(first, false) {
        Ok(value) => return Ok(value),
        Err(_) if is_cancelled() => return Err(crate::cancel::MESSAGE.into()),
        Err(error) if !official => return Err(error),
        Err(error) => error,
    };

    priority.demote(first);
    let second = priority
        .select(Some(first), &mut probe)
        .unwrap_or_else(|| first.next());
    crate::logging::event(
        "warn",
        "network",
        format!(
            "{}请求失败，已重新选择{}：{first_error}",
            first.label(),
            second.label()
        ),
    );
    if is_cancelled() {
        return Err(crate::cancel::MESSAGE.into());
    }
    // The retry flag tells the downloader to reset its progress.
    match attempt(second, true) {
        Ok(value) => Ok(value),
        Err(_) if is_cancelled() => Err(crate::cancel::MESSAGE.into()),
        Err(second_error) => {
            priority.demote(second);
            crate::logging::event(
                "error",
                "network",
                format!("{}也请求失败：{second_error}", second.label()),
            );
            Err(format!(
                "{}失败：{first_error}；{}失败：{second_error}",
                first.label(),
                second.label()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::VecDeque,
        sync::{mpsc, Arc},
        thread,
    };

    /// Runs `fetch` with a probe that reports exactly the routes in `dead` as
    /// unreachable, and returns the probes, attempts and result.
    fn attempts(
        priority: &RoutePriority,
        dead: &[Route],
        responses: &[(Route, Result<&'static str>)],
    ) -> (Result<&'static str>, Vec<(Route, bool)>, Vec<Route>) {
        let mut responses = VecDeque::from(responses.to_vec());
        let probes = RefCell::new(Vec::new());
        let mut seen = Vec::new();
        let result = fetch(
            priority,
            true,
            || false,
            |route| {
                probes.borrow_mut().push(route);
                !dead.contains(&route)
            },
            |route, retry| {
                seen.push((route, retry));
                let (expected, response) = responses.pop_front().expect("unexpected attempt");
                assert_eq!(route, expected);
                response
            },
        );
        assert!(responses.is_empty(), "missing attempt");
        (result, seen, probes.into_inner())
    }

    #[test]
    fn user_facing_labels_never_reveal_the_network() {
        assert_eq!(Route::Beijing.label(), "线路一");
        assert_eq!(Route::HongKong.label(), "线路二");
        assert_eq!(Route::Cloudflare.label(), "线路三");
        for route in Route::ORDER {
            let label = route.label();
            assert!(
                !label.contains("北京") && !label.contains("香港") && !label.contains("Cloudflare"),
                "{label} must stay anonymous"
            );
        }
    }

    #[test]
    fn the_first_healthy_route_wins_and_is_reused() {
        let priority = RoutePriority::new();
        let (result, seen, probes) = attempts(
            &priority,
            &[Route::Beijing],
            &[(Route::HongKong, Ok("downloaded"))],
        );
        assert_eq!(result.unwrap(), "downloaded");
        assert_eq!(seen, [(Route::HongKong, false)]);
        assert_eq!(probes, [Route::Beijing, Route::HongKong]);
        assert_eq!(priority.current(), Some(Route::HongKong));

        // The next request reuses the choice without probing again.
        let (_, seen, probes) = attempts(&priority, &[], &[(Route::HongKong, Ok("next"))]);
        assert_eq!(seen, [(Route::HongKong, false)]);
        assert!(probes.is_empty());
    }

    #[test]
    fn a_failed_route_is_replaced_by_the_next_healthy_one() {
        let priority = RoutePriority::new();
        priority.select(None, |_| true);
        assert_eq!(priority.current(), Some(Route::Beijing));
        let (result, seen, probes) = attempts(
            &priority,
            &[Route::Beijing],
            &[
                (Route::Beijing, Err("connect timeout".into())),
                (Route::HongKong, Ok("downloaded")),
            ],
        );
        assert_eq!(result.unwrap(), "downloaded");
        assert_eq!(seen, [(Route::Beijing, false), (Route::HongKong, true)]);
        assert_eq!(probes, [Route::HongKong]);
        assert_eq!(priority.current(), Some(Route::HongKong));
    }

    #[test]
    fn dead_routes_are_skipped_and_cloudflare_is_the_last_resort() {
        let priority = RoutePriority::new();
        let (result, seen, probes) = attempts(
            &priority,
            &[Route::Beijing, Route::HongKong, Route::Cloudflare],
            &[(Route::Cloudflare, Ok("ok"))],
        );
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(seen, [(Route::Cloudflare, false)]);
        assert_eq!(
            probes,
            [Route::Beijing, Route::HongKong, Route::Cloudflare]
        );
    }

    #[test]
    fn no_reachable_route_still_attempts_a_request_and_reports_both_failures() {
        let priority = RoutePriority::new();
        let mut responses: VecDeque<(Route, Result<&'static str>)> = VecDeque::from([
            (Route::Cloudflare, Err("cloudflare down".to_string())),
            (Route::Beijing, Err("beijing down".to_string())),
        ]);
        let result: Result<()> = fetch(
            &priority,
            true,
            || false,
            |_| false,
            |route, _| {
                let (expected, response) = responses.pop_front().expect("unexpected attempt");
                assert_eq!(route, expected);
                response.map(|_| ())
            },
        );
        let error = result.unwrap_err();
        assert!(error.contains("线路三失败：cloudflare down"));
        assert!(error.contains("线路一失败：beijing down"));
        assert_eq!(priority.current(), None);
    }

    #[test]
    fn unrelated_hosts_never_use_or_change_the_official_choice() {
        let priority = RoutePriority::new();
        priority.select(None, |route| route == Route::HongKong);
        let probes = Cell::new(0);
        let result: Result<()> = fetch(
            &priority,
            false,
            || false,
            |_| {
                probes.set(probes.get() + 1);
                true
            },
            |route, _| {
                assert_eq!(route, Route::Cloudflare);
                Err("unrelated error".into())
            },
        );
        assert_eq!(result.unwrap_err(), "unrelated error");
        assert_eq!(probes.get(), 0);
        assert_eq!(priority.current(), Some(Route::HongKong));
    }

    #[test]
    fn cancellation_does_not_demote_the_cancelled_attempt() {
        let priority = RoutePriority::new();
        priority.select(None, |route| route == Route::Beijing);
        let cancelled = Cell::new(false);
        let mut seen = Vec::new();
        let result: Result<()> = fetch(
            &priority,
            true,
            || cancelled.get(),
            |_| true,
            |route, _| {
                seen.push((route, false));
                cancelled.set(true);
                Err("interrupted".into())
            },
        );
        assert_eq!(result.unwrap_err(), crate::cancel::MESSAGE);
        assert_eq!(seen, [(Route::Beijing, false)]);
        assert_eq!(priority.current(), Some(Route::Beijing));

        cancelled.set(false);
        seen.clear();
        let result: Result<()> = fetch(
            &priority,
            true,
            || cancelled.get(),
            |_| true,
            |route, retry| {
                seen.push((route, retry));
                if retry {
                    cancelled.set(true);
                }
                Err("interrupted".into())
            },
        );
        assert_eq!(result.unwrap_err(), crate::cancel::MESSAGE);
        assert_eq!(seen, [(Route::Beijing, false), (Route::HongKong, true)]);
        assert_eq!(priority.current(), Some(Route::HongKong));
    }

    #[test]
    fn already_cancelled_request_never_starts_a_route() {
        let priority = RoutePriority::new();
        let result: Result<()> = fetch(
            &priority,
            true,
            || true,
            |_| panic!("a cancelled request must not probe"),
            |_, _| panic!("a cancelled request must not start"),
        );
        assert_eq!(result.unwrap_err(), crate::cancel::MESSAGE);
        assert_eq!(priority.current(), None);
    }

    #[test]
    fn success_from_an_older_request_does_not_undo_a_failure() {
        let priority = Arc::new(RoutePriority::new());
        priority.select(None, |route| route == Route::Beijing);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let old_priority = Arc::clone(&priority);
        let old_request = thread::spawn(move || {
            fetch(
                &old_priority,
                true,
                || false,
                |_| true,
                |route, _| {
                    assert_eq!(route, Route::Beijing);
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                },
            )
        });
        started_rx.recv().unwrap();
        // A separate request can change the choice while the first is in
        // flight; neither request blocks the other during network I/O.
        let (result, _, _) = attempts(
            &priority,
            &[Route::Beijing],
            &[
                (Route::Beijing, Err("timeout".into())),
                (Route::HongKong, Ok("downloaded")),
            ],
        );
        assert!(result.is_ok());
        release_tx.send(()).unwrap();
        assert!(old_request.join().unwrap().is_ok());
        assert_eq!(priority.current(), Some(Route::HongKong));
    }
}
