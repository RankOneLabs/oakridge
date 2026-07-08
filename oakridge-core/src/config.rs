use std::net::IpAddr;
use std::path::PathBuf;
use std::str::FromStr;

use axum::http::{HeaderValue, Uri};

/// Startup auth policy derived from bind address + env vars.
#[derive(Clone, Debug)]
pub enum AuthPolicy {
    /// Loopback bind: no auth required.
    Loopback,
    /// Non-loopback with a configured token: Bearer auth required on writes.
    Token(String),
    /// Non-loopback with ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1: no auth, warned at startup.
    InsecureNonLoopback,
}

fn is_loopback(addr: IpAddr) -> bool {
    addr.is_loopback()
}

/// Resolve the startup auth policy from bind address, optional token, and
/// insecure flag. Returns `Err` when the bind is non-loopback and neither a
/// token nor the insecure flag is configured.
pub fn resolve_auth_policy(
    bind_addr: IpAddr,
    control_token: Option<&str>,
    allow_insecure: bool,
) -> anyhow::Result<AuthPolicy> {
    if is_loopback(bind_addr) {
        return Ok(AuthPolicy::Loopback);
    }
    if let Some(token) = control_token.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(AuthPolicy::Token(token.to_owned()));
    }
    if allow_insecure {
        return Ok(AuthPolicy::InsecureNonLoopback);
    }
    anyhow::bail!(
        "oakridge-core: non-loopback bind ({bind_addr}) requires OAKRIDGE_CONTROL_TOKEN or ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1"
    );
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub bind_addr: IpAddr,
    pub db_url: String,
    pub pwa_dir: PathBuf,
    pub cors_origins: Vec<HeaderValue>,
    pub auth_policy: AuthPolicy,
    /// Seconds a Running stage may go without an updated_at bump before the
    /// stuck sweeper parks it. Default: 3600 (1 hour).
    pub stage_timeout_secs: u64,
    /// Interval between stuck-stage sweep passes. Default: 60 seconds.
    pub stuck_sweep_interval_secs: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let port = parse_port(std::env::var("OAKRIDGE_CORE_PORT").ok())?;
        let bind_addr = parse_bind_addr(std::env::var("OAKRIDGE_CORE_BIND").ok().as_deref())?;
        let db_url = std::env::var("OAKRIDGE_CORE_DB")
            .map(|p| {
                if p.starts_with("sqlite:") {
                    p
                } else {
                    format!("sqlite://{p}")
                }
            })
            .unwrap_or_else(|_| "sqlite://oakridge-core.db".to_string());
        let pwa_dir = std::env::var("OAKRIDGE_CORE_PWA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./pwa"));
        let cors_origins =
            parse_cors_origins(std::env::var("OAKRIDGE_CORE_CORS_ORIGINS").ok().as_deref())?;
        let control_token = std::env::var("OAKRIDGE_CONTROL_TOKEN").ok();
        let allow_insecure = std::env::var("ALLOW_INSECURE_NON_LOOPBACK_CONTROL")
            .ok()
            .as_deref()
            == Some("1");
        let auth_policy =
            resolve_auth_policy(bind_addr, control_token.as_deref(), allow_insecure)?;
        let stage_timeout_secs: u64 = std::env::var("OAKRIDGE_STAGE_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);
        let stuck_sweep_interval_secs: u64 = std::env::var("OAKRIDGE_STUCK_SWEEP_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);
        Ok(Self {
            port,
            bind_addr,
            db_url,
            pwa_dir,
            cors_origins,
            auth_policy,
            stage_timeout_secs,
            stuck_sweep_interval_secs,
        })
    }
}

fn parse_port(raw: Option<String>) -> anyhow::Result<u16> {
    match raw {
        Some(raw) => Ok(raw.parse()?),
        None => Ok(8790),
    }
}

fn parse_bind_addr(raw: Option<&str>) -> anyhow::Result<IpAddr> {
    match raw {
        Some(raw) => Ok(IpAddr::from_str(raw)?),
        None => Ok(IpAddr::from_str("127.0.0.1")?),
    }
}

fn parse_cors_origins(raw: Option<&str>) -> anyhow::Result<Vec<HeaderValue>> {
    let Some(raw) = raw.map(str::trim) else {
        return Ok(Vec::new());
    };

    if raw.is_empty() {
        return Ok(Vec::new());
    }

    raw.split(',').map(str::trim).map(parse_origin).collect()
}

fn parse_origin(raw: &str) -> anyhow::Result<HeaderValue> {
    if raw.is_empty() {
        anyhow::bail!("origin values must not be empty");
    }
    if raw.contains('*') {
        anyhow::bail!("wildcard origins are not allowed: {raw}");
    }

    let uri: Uri = raw.parse()?;
    let Some(scheme) = uri.scheme_str() else {
        anyhow::bail!("origin must include http or https scheme: {raw}");
    };
    if !matches!(scheme, "http" | "https") {
        anyhow::bail!("origin must use http or https: {raw}");
    }

    let Some(authority) = uri.authority() else {
        anyhow::bail!("origin must include a host: {raw}");
    };
    if authority.as_str().contains('@') {
        anyhow::bail!("origin must not include userinfo: {raw}");
    }
    if raw.ends_with('/') {
        anyhow::bail!("origin must not end with a trailing slash: {raw}");
    }
    if uri.path() != "/" || uri.query().is_some() {
        anyhow::bail!("origin must not include a path or query: {raw}");
    }

    Ok(HeaderValue::from_str(raw)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn default_bind_addr_is_local_only() {
        assert_eq!(
            parse_bind_addr(None).unwrap(),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
    }

    #[test]
    fn explicit_external_bind_addr_parses() {
        assert_eq!(
            parse_bind_addr(Some("0.0.0.0")).unwrap(),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
    }

    // --- resolve_auth_policy -----------------------------------------------

    #[test]
    fn loopback_ipv4_without_token_is_allowed() {
        let policy = resolve_auth_policy(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            None,
            false,
        )
        .unwrap();
        assert!(matches!(policy, AuthPolicy::Loopback));
    }

    #[test]
    fn loopback_ipv6_without_token_is_allowed() {
        let policy = resolve_auth_policy(
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            None,
            false,
        )
        .unwrap();
        assert!(matches!(policy, AuthPolicy::Loopback));
    }

    #[test]
    fn non_loopback_without_token_fails() {
        let err = resolve_auth_policy(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            None,
            false,
        )
        .unwrap_err();
        assert!(err.to_string().contains("OAKRIDGE_CONTROL_TOKEN"));
    }

    #[test]
    fn non_loopback_with_token_succeeds() {
        let policy = resolve_auth_policy(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            Some("my-secret"),
            false,
        )
        .unwrap();
        assert!(matches!(policy, AuthPolicy::Token(ref t) if t == "my-secret"));
    }

    #[test]
    fn non_loopback_with_insecure_flag_succeeds() {
        let policy = resolve_auth_policy(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            None,
            true,
        )
        .unwrap();
        assert!(matches!(policy, AuthPolicy::InsecureNonLoopback));
    }

    #[test]
    fn whitespace_only_token_treated_as_absent() {
        let err = resolve_auth_policy(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            Some("   "),
            false,
        )
        .unwrap_err();
        assert!(err.to_string().contains("OAKRIDGE_CONTROL_TOKEN"));
    }

    #[test]
    fn empty_cors_allow_list_means_no_extra_origins() {
        assert!(parse_cors_origins(None).unwrap().is_empty());
        assert!(parse_cors_origins(Some("")).unwrap().is_empty());
    }

    #[test]
    fn wildcard_origin_is_rejected() {
        let err = parse_cors_origins(Some("https://example.com,*")).unwrap_err();
        assert!(err.to_string().contains("wildcard origins are not allowed"));
    }

    #[test]
    fn invalid_origin_is_rejected() {
        let err = parse_cors_origins(Some("https://example.com/path")).unwrap_err();
        assert!(err.to_string().contains("path or query"));
    }

    #[test]
    fn valid_origins_are_accepted_and_trimmed() {
        let origins =
            parse_cors_origins(Some(" https://example.com , https://dashboard.example ")).unwrap();
        assert_eq!(
            origins,
            vec![
                HeaderValue::from_static("https://example.com"),
                HeaderValue::from_static("https://dashboard.example"),
            ]
        );
    }

    #[test]
    fn trailing_slash_origin_is_rejected() {
        let err = parse_cors_origins(Some("https://example.com/")).unwrap_err();
        assert!(err.to_string().contains("trailing slash"));
    }
}
