//! Verify existing deployment state before the runner funds accounts or submits transactions.

use anchor_lang::prelude::{ProgramData, Pubkey};
use anchor_lang::solana_program::bpf_loader_upgradeable::{self, UpgradeableLoaderState};
use anchor_lang::{AccountDeserialize, Owner};
use bonded_client::{address, TOKEN_PROGRAM};
use solana_commitment_config::CommitmentConfig;
use solana_program_pack::{IsInitialized, Pack};
use solana_rpc_client::rpc_client::RpcClient;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

use crate::Result;

/// An absent cover config has no pool yet; an empty initialized pool may be seeded once.
pub enum PoolState {
    Uninitialized,
    Unseeded,
    Funded,
}

pub struct Deployment {
    pub upgrade_authority: Pubkey,
    pub registry: Option<bonded_registry::Config>,
    pub vault: Option<bonded_vault::Config>,
    pub cover: Option<bonded_cover::Config>,
    pub mint_exists: bool,
    pub pool: PoolState,
}

impl Deployment {
    pub fn require_initialized(&self) -> Result<()> {
        if !self.mint_exists
            || self.registry.is_none()
            || self.vault.is_none()
            || self.cover.is_none()
            || matches!(self.pool, PoolState::Uninitialized)
        {
            return Err("not set up yet: run `bonded-devnet setup` first".into());
        }
        Ok(())
    }
}

fn matches_key(label: &str, actual: &Pubkey, expected: &Pubkey) -> Result<()> {
    if actual != expected {
        return Err(format!(
            "{label} is {actual}, but this runner expects {expected}; check the deployment and configured keys"
        )
        .into());
    }
    Ok(())
}

/// An Anchor discriminator is insufficient: enforce ownership and a non-executable account too.
pub fn read_optional<T: AccountDeserialize + Owner>(
    rpc: &RpcClient,
    address: &Pubkey,
) -> Result<Option<T>> {
    let Some(account) = rpc
        .get_account_with_commitment(address, CommitmentConfig::confirmed())?
        .value
    else {
        return Ok(None);
    };
    matches_key("account owner", &account.owner, &T::owner())?;
    if account.executable {
        return Err(format!("account {address} must not be executable").into());
    }
    Ok(Some(T::try_deserialize(&mut &account.data[..])?))
}

pub fn read<T: AccountDeserialize + Owner>(rpc: &RpcClient, address: &Pubkey) -> Result<T> {
    read_optional(rpc, address)?
        .ok_or_else(|| format!("required account {address} is missing").into())
}

fn upgrade_authority(rpc: &RpcClient, program: &Pubkey, admin: &Pubkey) -> Result<Pubkey> {
    let account = rpc
        .get_account_with_commitment(program, CommitmentConfig::confirmed())?
        .value
        .ok_or_else(|| {
            format!(
                "program {program} isn't deployed; deploy it first (contracts/solana/README.md)"
            )
        })?;
    matches_key("program owner", &account.owner, &bpf_loader_upgradeable::ID)?;
    if !account.executable {
        return Err(format!("program {program} is not executable").into());
    }
    let UpgradeableLoaderState::Program {
        programdata_address,
    } = UpgradeableLoaderState::try_deserialize(&mut &account.data[..])?
    else {
        return Err(format!("program {program} has invalid upgradeable loader state").into());
    };
    matches_key(
        "program data address",
        &programdata_address,
        &address::programdata(program),
    )?;
    let data: ProgramData = read(rpc, &programdata_address)?;
    let authority = data
        .upgrade_authority_address
        .ok_or_else(|| format!("program {program} is immutable and has no upgrade authority"))?;
    matches_key("program upgrade authority", &authority, admin)?;
    Ok(authority)
}

fn read_token<T: Pack + IsInitialized>(
    rpc: &RpcClient,
    address: &Pubkey,
    label: &str,
) -> Result<Option<T>> {
    let Some(account) = rpc
        .get_account_with_commitment(address, CommitmentConfig::confirmed())?
        .value
    else {
        return Ok(None);
    };
    matches_key("token account owner", &account.owner, &TOKEN_PROGRAM)?;
    if account.executable {
        return Err(format!("token account {address} must not be executable").into());
    }
    Ok(Some(
        T::unpack(&account.data).map_err(|error| format!("{label} {address}: {error}"))?,
    ))
}

fn check_mint(mint: &Mint, authority: &Pubkey, label: &str) -> Result<()> {
    if mint.decimals != 6 {
        return Err(format!("{label} must have 6 decimals, found {}", mint.decimals).into());
    }
    if Option::<Pubkey>::from(mint.mint_authority) != Some(*authority) {
        return Err(format!("{label} mint authority does not match {authority}; restore the original deployment keys").into());
    }
    Ok(())
}

/// Allow partial initialization only when every existing account agrees with this deployment.
pub fn verify(
    rpc: &RpcClient,
    admin: &Pubkey,
    attester: &Pubkey,
    mint: &Pubkey,
) -> Result<Deployment> {
    let authority = upgrade_authority(rpc, &bonded_registry::ID, admin)?;
    upgrade_authority(rpc, &bonded_vault::ID, admin)?;
    upgrade_authority(rpc, &bonded_cover::ID, admin)?;

    let registry: Option<bonded_registry::Config> =
        read_optional(rpc, &address::registry_config())?;
    if let Some(config) = &registry {
        matches_key("registry admin", &config.admin, admin)?;
        matches_key("registry attester", &config.attester, attester)?;
    }
    let vault: Option<bonded_vault::Config> = read_optional(rpc, &address::vault_config())?;
    if let Some(config) = &vault {
        matches_key("vault admin", &config.admin, admin)?;
        matches_key(
            "vault cover authority",
            &config.cover_authority,
            &address::claims_authority(),
        )?;
    }
    let cover: Option<bonded_cover::Config> = read_optional(rpc, &address::cover_config())?;
    if let Some(config) = &cover {
        matches_key("cover admin", &config.admin, admin)?;
        matches_key("cover attester", &config.attester, attester)?;
        matches_key("cover base mint", &config.base_mint, mint)?;
    }

    let base_mint: Option<Mint> = read_token(rpc, mint, "test-USD mint")?;
    if let Some(state) = &base_mint {
        check_mint(state, admin, "test-USD mint")?;
    } else if cover.is_some() {
        return Err("existing cover config has a missing test-USD mint".into());
    }
    let pool: Option<TokenAccount> = read_token(rpc, &address::pool_vault(), "pool vault")?;
    let shares: Option<Mint> = read_token(rpc, &address::share_mint(), "pool share mint")?;
    let pool = if cover.is_some() {
        let pool = pool.ok_or("existing cover config has a missing pool vault")?;
        let shares = shares.ok_or("existing cover config has a missing share mint")?;
        matches_key("pool vault mint", &pool.mint, mint)?;
        matches_key(
            "pool vault authority",
            &pool.owner,
            &address::cover_config(),
        )?;
        if pool.state != AccountState::Initialized {
            return Err("pool vault must be initialized and unfrozen".into());
        }
        check_mint(&shares, &address::cover_config(), "pool share mint")?;
        if pool.amount == 0 && shares.supply > 0 {
            return Err("pool is depleted with outstanding shares; setup cannot recapitalize it and will not mint more test USD".into());
        }
        if pool.amount == 0 {
            PoolState::Unseeded
        } else {
            PoolState::Funded
        }
    } else {
        if pool.is_some() || shares.is_some() {
            return Err(
                "pool accounts exist without a cover config; cannot initialize this deployment"
                    .into(),
            );
        }
        PoolState::Uninitialized
    };
    Ok(Deployment {
        upgrade_authority: authority,
        registry,
        vault,
        cover,
        mint_exists: base_mint.is_some(),
        pool,
    })
}
