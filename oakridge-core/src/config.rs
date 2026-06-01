use std::net::IpAddr;
use std::path::PathBuf;
use std::str::FromStr;

use axum::http::{HeaderValue, Uri};

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub bind_addr: IpAddr,
    pub db_url: String,
    pub pwa_dir: PathBuf,
    pub cors_origins: Vec<HeaderValue>,
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
        Ok(Self {
            port,
            bind_addr,
            db_url,
            pwa_dir,
            cors_origins,
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
    use std::net::{IpAddr, Ipv4Addr};

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
    fn trailing_slash_origin_is_rejected() {
        let err = parse_cors_origins(Some("https://example.com/")).unwrap_err();
        assert!(err.to_string().contains("trailing slash"));
    }
}
