//! Addresses and instructions for the three Bonded programs, built the same way everywhere:
//! the LiteSVM tests (`tests/flow.rs`), the devnet runner (`bonded_devnet`) and the keeper.
//! Nothing here signs or sends; callers bring their own keys and connection.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{InstructionData, ToAccountMetas};

pub use bonded_cover::{quote_message, Quote};
pub use bonded_registry::{attestation_message, Attestation};
pub use bonded_vault::{BreachType, VaultParams};

pub const TOKEN_PROGRAM: Pubkey = anchor_spl_token_id();
pub const SYSTEM_PROGRAM: Pubkey = anchor_lang::system_program::ID;
pub const INSTRUCTIONS_SYSVAR: Pubkey = bonded_ed25519::INSTRUCTIONS_SYSVAR_ID;
pub const ED25519_PROGRAM: Pubkey =
    Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
/// Base units per dollar: the stablecoin has 6 decimals.
pub const USD: u64 = 1_000_000;

const fn anchor_spl_token_id() -> Pubkey {
    Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

/// Program-derived addresses, named as the programs name them.
pub mod address {
    use super::*;

    pub fn programdata(program: &Pubkey) -> Pubkey {
        pda(&[program.as_ref()], &bpf_loader_upgradeable::ID)
    }
    pub fn registry_config() -> Pubkey {
        pda(&[b"config"], &bonded_registry::ID)
    }
    pub fn agent(agent_id: u64) -> Pubkey {
        pda(&[b"agent", &agent_id.to_le_bytes()], &bonded_registry::ID)
    }
    pub fn vault_config() -> Pubkey {
        pda(&[b"config"], &bonded_vault::ID)
    }
    pub fn vault(guardian: &Pubkey, agent_id: u64) -> Pubkey {
        pda(
            &[b"vault", guardian.as_ref(), &agent_id.to_le_bytes()],
            &bonded_vault::ID,
        )
    }
    pub fn vault_base(vault: &Pubkey) -> Pubkey {
        pda(&[b"base", vault.as_ref()], &bonded_vault::ID)
    }
    pub fn cover_config() -> Pubkey {
        pda(&[b"config"], &bonded_cover::ID)
    }
    pub fn pool_vault() -> Pubkey {
        pda(&[b"pool_vault"], &bonded_cover::ID)
    }
    pub fn share_mint() -> Pubkey {
        pda(&[b"shares"], &bonded_cover::ID)
    }
    /// The cover program's signer for paying claims: the vault program's `cover_authority`.
    pub fn claims_authority() -> Pubkey {
        pda(&[b"claims"], &bonded_cover::ID)
    }
    pub fn bond(agent_id: u64) -> Pubkey {
        pda(&[b"bond", &agent_id.to_le_bytes()], &bonded_cover::ID)
    }
    pub fn bond_vault(agent_id: u64) -> Pubkey {
        pda(&[b"bond_vault", &agent_id.to_le_bytes()], &bonded_cover::ID)
    }
    pub fn policy(policy_id: u64) -> Pubkey {
        pda(&[b"policy", &policy_id.to_le_bytes()], &bonded_cover::ID)
    }
    pub fn quote_record(vault: &Pubkey, nonce: u64) -> Pubkey {
        pda(
            &[b"quote", vault.as_ref(), &nonce.to_le_bytes()],
            &bonded_cover::ID,
        )
    }
}

/// An Ed25519 program instruction checking `signature` by `signer` over `message`, all inline:
/// the form the registry and cover programs look for just before their own instruction.
pub fn ed25519_verify(signer: &Pubkey, signature: &[u8; 64], message: &[u8]) -> Instruction {
    let (key_at, sig_at, msg_at) = (16u16, 48u16, 112u16);
    let mut data = vec![1u8, 0];
    for v in [
        sig_at,
        u16::MAX,
        key_at,
        u16::MAX,
        msg_at,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(signer.as_ref());
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    Instruction::new_with_bytes(ED25519_PROGRAM, &data, vec![])
}

/// One-time setup of all three programs. `admin` must be each program's upgrade authority.
pub fn initialize_all(admin: &Pubkey, attester: &Pubkey, base_mint: &Pubkey) -> [Instruction; 3] {
    [
        Instruction::new_with_bytes(
            bonded_registry::ID,
            &bonded_registry::instruction::Initialize {
                attester: *attester,
            }
            .data(),
            bonded_registry::accounts::Initialize {
                config: address::registry_config(),
                admin: *admin,
                program: bonded_registry::ID,
                program_data: address::programdata(&bonded_registry::ID),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
        ),
        Instruction::new_with_bytes(
            bonded_vault::ID,
            &bonded_vault::instruction::Initialize {
                cover_authority: address::claims_authority(),
            }
            .data(),
            bonded_vault::accounts::Initialize {
                config: address::vault_config(),
                admin: *admin,
                program: bonded_vault::ID,
                program_data: address::programdata(&bonded_vault::ID),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
        ),
        Instruction::new_with_bytes(
            bonded_cover::ID,
            &bonded_cover::instruction::Initialize {
                attester: *attester,
            }
            .data(),
            bonded_cover::accounts::Initialize {
                config: address::cover_config(),
                pool_vault: address::pool_vault(),
                share_mint: address::share_mint(),
                base_mint: *base_mint,
                admin: *admin,
                program: bonded_cover::ID,
                program_data: address::programdata(&bonded_cover::ID),
                token_program: TOKEN_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
        ),
    ]
}

/// Register a new agent owned by `owner`. Its id is the registry's agent count plus one.
pub fn register(owner: &Pubkey, next_agent_id: u64, uri: &str) -> Instruction {
    Instruction::new_with_bytes(
        bonded_registry::ID,
        &bonded_registry::instruction::Register { uri: uri.into() }.data(),
        bonded_registry::accounts::Register {
            config: address::registry_config(),
            agent: address::agent(next_agent_id),
            owner: *owner,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// Post a score: the attester's signature check, then the registry instruction. `signed` is
/// the attestation the signature covers; it differs from `attestation` only in tests of
/// refusals.
pub fn post_score(
    attestation: &Attestation,
    attester: &Pubkey,
    signature: &[u8; 64],
    signed: &Attestation,
) -> [Instruction; 2] {
    [
        ed25519_verify(
            attester,
            signature,
            &attestation_message(&bonded_registry::ID, signed),
        ),
        Instruction::new_with_bytes(
            bonded_registry::ID,
            &bonded_registry::instruction::PostScore {
                attestation: attestation.clone(),
            }
            .data(),
            bonded_registry::accounts::PostScore {
                config: address::registry_config(),
                agent: address::agent(attestation.agent_id),
                instructions: INSTRUCTIONS_SYSVAR,
            }
            .to_account_metas(None),
        ),
    ]
}

/// Create a vault for `params.agent_id`, guarded by `guardian`, holding `base_mint`.
pub fn create_vault(guardian: &Pubkey, base_mint: &Pubkey, params: VaultParams) -> Instruction {
    let vault = address::vault(guardian, params.agent_id);
    Instruction::new_with_bytes(
        bonded_vault::ID,
        &bonded_vault::instruction::CreateVault { params }.data(),
        bonded_vault::accounts::CreateVault {
            vault,
            base_account: address::vault_base(&vault),
            base_mint: *base_mint,
            guardian: *guardian,
            token_program: TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None),
    )
}

pub fn vault_deposit(
    vault: &Pubkey,
    base_mint: &Pubkey,
    from: &Pubkey,
    depositor: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        bonded_vault::ID,
        &bonded_vault::instruction::Deposit { amount }.data(),
        bonded_vault::accounts::Deposit {
            vault: *vault,
            base_account: address::vault_base(vault),
            base_mint: *base_mint,
            from: *from,
            depositor: *depositor,
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// The agent asks the vault to run `inner`, an instruction the vault signs for. The vault
/// records a breach (and blocks it in Enforce mode) before or after running it.
pub fn execute(vault: &Pubkey, agent: &Pubkey, inner: Instruction) -> Instruction {
    let mut metas = bonded_vault::accounts::Execute {
        vault: *vault,
        agent: *agent,
        base_account: address::vault_base(vault),
        target_program: inner.program_id,
    }
    .to_account_metas(None);
    // The vault signs the inner call itself; in the outer transaction it is not a signer.
    metas.extend(inner.accounts.iter().map(|m| AccountMeta {
        is_signer: m.is_signer && m.pubkey != *vault,
        ..m.clone()
    }));
    Instruction::new_with_bytes(
        bonded_vault::ID,
        &bonded_vault::instruction::Execute { data: inner.data }.data(),
        metas,
    )
}

/// An underwriter deposits into the pool and receives shares at `shares_to`.
pub fn pool_deposit(
    base_mint: &Pubkey,
    from: &Pubkey,
    shares_to: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        bonded_cover::ID,
        &bonded_cover::instruction::Deposit { amount }.data(),
        bonded_cover::accounts::PoolDeposit {
            config: address::cover_config(),
            pool_vault: address::pool_vault(),
            share_mint: address::share_mint(),
            base_mint: *base_mint,
            from: *from,
            shares_to: *shares_to,
            owner: *owner,
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// The agent's registry owner posts a bond for it.
pub fn stake(
    agent_id: u64,
    base_mint: &Pubkey,
    from: &Pubkey,
    operator: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        bonded_cover::ID,
        &bonded_cover::instruction::Stake { agent_id, amount }.data(),
        bonded_cover::accounts::Stake {
            config: address::cover_config(),
            agent: address::agent(agent_id),
            bond: address::bond(agent_id),
            bond_vault: address::bond_vault(agent_id),
            base_mint: *base_mint,
            from: *from,
            operator: *operator,
            token_program: TOKEN_PROGRAM,
            system_program: SYSTEM_PROGRAM,
        }
        .to_account_metas(None),
    )
}

/// Bind cover with an attester-signed quote. The policy's id is the cover program's
/// `next_policy_id`; the guardian pays the premium from `premium_from`.
#[allow(clippy::too_many_arguments)]
pub fn buy_cover(
    quote: &Quote,
    attester: &Pubkey,
    signature: &[u8; 64],
    next_policy_id: u64,
    base_mint: &Pubkey,
    premium_from: &Pubkey,
    guardian: &Pubkey,
) -> [Instruction; 2] {
    [
        ed25519_verify(
            attester,
            signature,
            &quote_message(&bonded_cover::ID, quote),
        ),
        Instruction::new_with_bytes(
            bonded_cover::ID,
            &bonded_cover::instruction::BuyCover {
                quote: quote.clone(),
            }
            .data(),
            bonded_cover::accounts::BuyCover {
                config: address::cover_config(),
                vault: quote.vault,
                agent: address::agent(quote.agent_id),
                bond: address::bond(quote.agent_id),
                policy: address::policy(next_policy_id),
                quote_record: address::quote_record(&quote.vault, quote.nonce),
                pool_vault: address::pool_vault(),
                base_mint: *base_mint,
                premium_from: *premium_from,
                guardian: *guardian,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
        ),
    ]
}

/// File a claim for breaches `breach_ids` in the policy's vault. Anyone can file; the payout
/// goes to the vault, bond first, then the pool, less the deductible.
pub fn file_claim(
    policy_id: u64,
    agent_id: u64,
    vault: &Pubkey,
    base_mint: &Pubkey,
    breach_ids: Vec<u8>,
) -> Instruction {
    Instruction::new_with_bytes(
        bonded_cover::ID,
        &bonded_cover::instruction::FileClaim { breach_ids }.data(),
        bonded_cover::accounts::FileClaim {
            config: address::cover_config(),
            policy: address::policy(policy_id),
            vault: *vault,
            vault_base: address::vault_base(vault),
            bond: address::bond(agent_id),
            bond_vault: address::bond_vault(agent_id),
            pool_vault: address::pool_vault(),
            base_mint: *base_mint,
            claims_authority: address::claims_authority(),
            vault_config: address::vault_config(),
            vault_program: bonded_vault::ID,
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None),
    )
}
