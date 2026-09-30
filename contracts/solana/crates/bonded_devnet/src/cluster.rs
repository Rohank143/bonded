//! Identify the connected chain before the runner loads keys or sends transactions.
//!
//! Public cluster identity comes from `getGenesisHash`, never an endpoint's name. A custom
//! local validator has its own genesis, so it is allowed only on a parsed loopback host.

use std::error::Error;
use std::fmt;

use url::{Host, Url};

// Solana's known cluster hashes (`sdk/src/genesis_config.rs`), also verified against each
// public RPC endpoint. See https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs.
const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const TESTNET_GENESIS: &str = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/// Errors omit the endpoint: its username, password, path or query may contain credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClusterError {
    InvalidRpcUrl,
    UnsupportedRpcScheme,
    Mainnet,
    Testnet,
    RemoteUnknownCluster,
}

impl fmt::Display for ClusterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRpcUrl => "SOLANA_RPC_URL must be a valid absolute URL with a host",
            Self::UnsupportedRpcScheme => "SOLANA_RPC_URL must use http or https",
            Self::Mainnet => "refusing mainnet: this runner supports devnet or a local validator",
            Self::Testnet => "refusing testnet: this runner supports devnet or a local validator",
            Self::RemoteUnknownCluster => {
                "RPC genesis is not devnet; custom local validators require a loopback host"
            }
        };
        formatter.write_str(message)
    }
}

impl Error for ClusterError {}

/// Validate before contacting the RPC, without including credentials in a parse error.
pub fn validate_rpc_url(rpc_url: &str) -> Result<Url, ClusterError> {
    let url = Url::parse(rpc_url).map_err(|_| ClusterError::InvalidRpcUrl)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ClusterError::UnsupportedRpcScheme);
    }
    if url.host().is_none() {
        return Err(ClusterError::InvalidRpcUrl);
    }
    Ok(url)
}

/// `genesis_hash` must be the connected RPC's `getGenesisHash` response. Devnet is accepted
/// through any HTTP(S) provider. Known public mainnet/testnet chains are rejected even through
/// a localhost proxy; other chains are accepted only for local-validator rehearsals.
pub fn verify_cluster(rpc_url: &str, genesis_hash: &str) -> Result<&'static str, ClusterError> {
    let url = validate_rpc_url(rpc_url)?;
    match genesis_hash {
        DEVNET_GENESIS => return Ok("devnet"),
        MAINNET_GENESIS => return Err(ClusterError::Mainnet),
        TESTNET_GENESIS => return Err(ClusterError::Testnet),
        _ => {}
    }
    let is_loopback = match url.host() {
        Some(Host::Domain(host)) => host == "localhost",
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if is_loopback {
        Ok("localnet")
    } else {
        Err(ClusterError::RemoteUnknownCluster)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL_GENESIS: &str = "11111111111111111111111111111111";

    #[test]
    fn accepts_verified_devnet_through_custom_providers() {
        for endpoint in [
            "https://rpc.example.com/v1/private-token",
            "http://provider.example.com:8899/?api-key=secret",
            "http://127.0.0.1:8899",
        ] {
            assert_eq!(verify_cluster(endpoint, DEVNET_GENESIS), Ok("devnet"));
        }
    }

    #[test]
    fn endpoint_labels_cannot_override_the_reported_chain() {
        for endpoint in [
            "https://api.example.com/?devnet",
            "https://devnet.example.com/",
            "https://example.com/devnet",
        ] {
            assert_eq!(
                verify_cluster(endpoint, MAINNET_GENESIS),
                Err(ClusterError::Mainnet)
            );
            assert_eq!(
                verify_cluster(endpoint, LOCAL_GENESIS),
                Err(ClusterError::RemoteUnknownCluster)
            );
        }
    }

    #[test]
    fn accepts_only_actual_loopback_hosts_for_local_validators() {
        for endpoint in [
            "http://localhost:8899",
            "http://LOCALHOST:8899",
            "http://127.0.0.1:8899",
            "http://127.23.4.5:8899",
            "http://[::1]:8899",
        ] {
            assert_eq!(verify_cluster(endpoint, LOCAL_GENESIS), Ok("localnet"));
        }
    }

    #[test]
    fn localhost_substrings_and_nonloopback_addresses_are_rejected() {
        for endpoint in [
            "http://localhost.example.com:8899",
            "http://127.0.0.1.example.com:8899",
            "https://example.com/?rpc=localhost",
            "https://localhost@example.com/",
            "http://192.168.1.1:8899",
            "http://[::2]:8899",
        ] {
            assert_eq!(
                verify_cluster(endpoint, LOCAL_GENESIS),
                Err(ClusterError::RemoteUnknownCluster)
            );
        }
    }

    #[test]
    fn public_nondevnet_genesis_is_rejected_even_through_loopback_proxies() {
        for endpoint in [
            "http://localhost:8899",
            "http://127.0.0.1:8899",
            "http://[::1]:8899",
        ] {
            assert_eq!(
                verify_cluster(endpoint, MAINNET_GENESIS),
                Err(ClusterError::Mainnet)
            );
            assert_eq!(
                verify_cluster(endpoint, TESTNET_GENESIS),
                Err(ClusterError::Testnet)
            );
        }
    }

    #[test]
    fn requires_a_valid_http_endpoint_even_for_devnet() {
        for endpoint in ["not a URL", "http://", "https://[::1"] {
            assert_eq!(
                verify_cluster(endpoint, DEVNET_GENESIS),
                Err(ClusterError::InvalidRpcUrl)
            );
        }
        for endpoint in [
            "ftp://localhost",
            "file:///tmp/devnet",
            "ws://localhost:8899",
        ] {
            assert_eq!(
                verify_cluster(endpoint, DEVNET_GENESIS),
                Err(ClusterError::UnsupportedRpcScheme)
            );
        }
    }

    #[test]
    fn errors_never_contain_rpc_credentials() {
        let endpoint = "https://private-user:private-password@localhost.example.com/private-token?api-key=private-key";
        let error = verify_cluster(endpoint, LOCAL_GENESIS).unwrap_err();
        for secret in [
            "private-user",
            "private-password",
            "private-token",
            "private-key",
        ] {
            assert!(!error.to_string().contains(secret));
            assert!(!format!("{error:?}").contains(secret));
        }
    }
}
