//! Bonded mandate vault on Solana (docs/SPECIFICATION.md Sections 6.3 and 7). Mirrors `MandateVault`:
//! the vault account owns the agent's funds, the agent's key can only act through `execute`,
//! every action is classified against the mandate first, breaches are logged in the vault, and
//! the vault freezes on a breach. The breach log is what pays claims, so no model output can
//! change it.
//!
//! Classification on Solana:
//! - T1 target: the called program must be on the vault's allowlist.
//! - T1 transfer: an SPL `Transfer`/`TransferChecked` must go to a token account the vault owns.
//! - T1 approval: `Approve`, `ApproveChecked` and `SetAuthority` are never allowed.
//! - T2 limit: the net base-asset outflow of one call (moves between the vault's own accounts
//!   do not count) must not exceed the per-call limit.
//!
//! T3 (asset) needs an on-chain price and is not implemented on Solana yet.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("8hNVDFF7aU2BJa4avnv2X7ziYEmguCaCHTZYBKo2CzFx");

pub const MAX_ALLOWED_PROGRAMS: usize = 8;
/// Once this many breaches are logged the agent can no longer act (the vault is frozen long
/// before in practice).
pub const MAX_BREACHES: usize = 16;

/// SPL Token instruction tags (spl-token `TokenInstruction`), shared by Token-2022.
mod tag {
    pub const TRANSFER: u8 = 3;
    pub const APPROVE: u8 = 4;
    pub const SET_AUTHORITY: u8 = 6;
    pub const CLOSE_ACCOUNT: u8 = 9;
    pub const TRANSFER_CHECKED: u8 = 12;
    pub const APPROVE_CHECKED: u8 = 13;
}
/// Token-2022 shares the SPL Token instruction layout for these instructions.
pub const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[program]
pub mod bonded_vault {
    use super::*;

    /// One-time setup. `cover_authority` is the cover program's claims signer, the only key
    /// that can mark breaches as paid.
    pub fn initialize(ctx: Context<Initialize>, cover_authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.cover_authority = cover_authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Create a vault for one agent. The signer is the guardian.
    pub fn create_vault(ctx: Context<CreateVault>, params: VaultParams) -> Result<()> {
        require!(
            params.allowed_programs.len() <= MAX_ALLOWED_PROGRAMS,
            VaultError::TooManyPrograms
        );
        require!(
            !params.allowed_programs.contains(&crate::ID),
            VaultError::SelfCall
        );
        let vault = &mut ctx.accounts.vault;
        vault.guardian = ctx.accounts.guardian.key();
        vault.agent = params.agent;
        vault.agent_id = params.agent_id;
        vault.mandate_hash = params.mandate_hash;
        vault.enforce = params.enforce;
        vault.freeze_on_breach = params.freeze_on_breach;
        vault.base_mint = ctx.accounts.base_mint.key();
        vault.base_account = ctx.accounts.base_account.key();
        vault.allowed_programs = params.allowed_programs;
        vault.max_outflow_per_call = params.max_outflow_per_call;
        vault.frozen = false;
        vault.breaches = Vec::new();
        vault.bump = ctx.bumps.vault;
        emit!(VaultCreated {
            vault: vault.key(),
            agent_id: vault.agent_id,
            guardian: vault.guardian,
            agent: vault.agent,
            mandate_hash: vault.mandate_hash,
        });
        Ok(())
    }

    /// Anyone can add base asset to the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.base_account.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.base_mint.decimals,
        )
    }

    /// The guardian takes base asset out, frozen or not.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let seeds = vault_seeds!(vault);
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.base_account.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: vault.to_account_info(),
                },
                &[&seeds[..]],
            ),
            amount,
            ctx.accounts.base_mint.decimals,
        )
    }

    pub fn freeze(ctx: Context<GuardianOnly>) -> Result<()> {
        ctx.accounts.vault.frozen = true;
        emit!(Frozen {
            vault: ctx.accounts.vault.key()
        });
        Ok(())
    }

    pub fn unfreeze(ctx: Context<GuardianOnly>) -> Result<()> {
        ctx.accounts.vault.frozen = false;
        emit!(Unfrozen {
            vault: ctx.accounts.vault.key()
        });
        Ok(())
    }

    /// Replace the agent's key, e.g. after a compromise.
    pub fn rotate_agent(ctx: Context<GuardianOnly>, new_agent: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        emit!(AgentRotated {
            vault: vault.key(),
            previous: vault.agent,
            new_agent
        });
        vault.agent = new_agent;
        Ok(())
    }

    /// The agent's only way to act: call `target_program` with `data`, the vault signing. The
    /// accounts for the call are the remaining accounts, in order.
    pub fn execute<'info>(ctx: Context<'info, Execute<'info>>, data: Vec<u8>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        require!(!ctx.accounts.vault.frozen, VaultError::Frozen);
        require!(
            ctx.accounts.vault.breaches.len() < MAX_BREACHES,
            VaultError::BreachLogFull
        );
        let target = ctx.accounts.target_program.key();
        require!(target != crate::ID, VaultError::SelfCall);

        let accounts = ctx.remaining_accounts;
        let pre = classify(&ctx.accounts.vault, &target, &data, accounts);
        let now = Clock::get()?.unix_timestamp;

        if let Some(breach_type) = pre {
            if ctx.accounts.vault.enforce {
                // Enforce mode: the call never runs; the attempt is logged and the agent frozen.
                record(&mut ctx.accounts.vault, breach_type, true, target, now, 0);
                return Ok(());
            }
        }

        let base_info = ctx.accounts.base_account.to_account_info();
        let before = base_holdings(&vault_key, &base_info, accounts);
        let metas = accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: a.key(),
                is_signer: a.is_signer || a.key() == vault_key,
                is_writable: a.is_writable,
            })
            .collect();
        let mut infos = accounts.to_vec();
        infos.push(ctx.accounts.target_program.to_account_info());
        let vault = &ctx.accounts.vault;
        let seeds = vault_seeds!(vault);
        invoke_signed(
            &Instruction {
                program_id: target,
                accounts: metas,
                data,
            },
            &infos,
            &[&seeds[..]],
        )?;
        let after = base_holdings(&vault_key, &base_info, accounts);
        let outflow = before.saturating_sub(after);

        let breach = pre.or_else(|| {
            (outflow > ctx.accounts.vault.max_outflow_per_call).then_some(BreachType::Limit)
        });
        if let Some(breach_type) = breach {
            record(
                &mut ctx.accounts.vault,
                breach_type,
                false,
                target,
                now,
                outflow,
            );
        }
        Ok(())
    }

    /// Called by the cover program when it pays a claim, so a breach is paid once.
    pub fn mark_claimed(ctx: Context<MarkClaimed>, breach_ids: Vec<u8>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        for id in breach_ids {
            let breach = vault
                .breaches
                .get_mut(usize::from(id))
                .ok_or(VaultError::UnknownBreach)?;
            require!(!breach.claimed, VaultError::AlreadyClaimed);
            breach.claimed = true;
            emit!(BreachClaimed {
                vault: vault.key(),
                breach_id: id
            });
        }
        Ok(())
    }
}

/// Classify a call before it runs. `None` means it is allowed so far; the outflow limit is
/// checked after the call.
pub fn classify(
    vault: &Vault,
    target: &Pubkey,
    data: &[u8],
    accounts: &[AccountInfo],
) -> Option<BreachType> {
    if !vault.allowed_programs.contains(target) {
        return Some(BreachType::UnauthorizedTarget);
    }
    if *target != token::ID && *target != TOKEN_2022_ID {
        return None;
    }
    let destination = match data.first() {
        Some(&tag::TRANSFER) => accounts.get(1),
        Some(&tag::TRANSFER_CHECKED) => accounts.get(2),
        Some(&tag::APPROVE) | Some(&tag::APPROVE_CHECKED) | Some(&tag::SET_AUTHORITY) => {
            return Some(BreachType::UnauthorizedApproval)
        }
        // Closing sends the account's lamports elsewhere and ends the vault's control of it.
        Some(&tag::CLOSE_ACCOUNT) => return Some(BreachType::UnauthorizedTransfer),
        _ => return None,
    };
    match destination {
        Some(account) if owned_by_vault(account, target, vault) => None,
        _ => Some(BreachType::UnauthorizedTransfer),
    }
}

/// Total base asset in the base account and every other base-asset token account the vault owns
/// among the call's accounts. Outflow is measured on this total, so moving funds between the
/// vault's own accounts is not a loss.
fn base_holdings(vault: &Pubkey, base: &AccountInfo, accounts: &[AccountInfo]) -> u64 {
    let mut seen = vec![base.key()];
    let mut total = token_amount(base).unwrap_or(0);
    for account in accounts {
        if seen.contains(account.key) {
            continue;
        }
        seen.push(account.key());
        if account.owner != base.owner {
            continue;
        }
        let Ok(data) = account.try_borrow_data() else {
            continue;
        };
        let Ok(base_data) = base.try_borrow_data() else {
            continue;
        };
        // Same mint (bytes 0..32) and owned by the vault (bytes 32..64) as the base account.
        if data.len() >= 72 && data[..32] == base_data[..32] && data[32..64] == vault.to_bytes() {
            total = total.saturating_add(u64::from_le_bytes(data[64..72].try_into().unwrap()));
        }
    }
    total
}

fn token_amount(account: &AccountInfo) -> Option<u64> {
    let data = account.try_borrow_data().ok()?;
    (data.len() >= 72).then(|| u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// A token account of `token_program` whose owner field is the vault.
fn owned_by_vault(account: &AccountInfo, token_program: &Pubkey, vault: &Vault) -> bool {
    if account.owner != token_program {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    // SPL token account layout: mint (32 bytes), then owner (32 bytes).
    data.len() >= 64 && data[32..64] == vault_address(vault).to_bytes()
}

pub fn vault_address(vault: &Vault) -> Pubkey {
    Pubkey::create_program_address(
        &[
            b"vault",
            vault.guardian.as_ref(),
            &vault.agent_id.to_le_bytes(),
            &[vault.bump],
        ],
        &crate::ID,
    )
    .expect("stored bump is valid")
}

fn record(
    vault: &mut Vault,
    breach_type: BreachType,
    blocked: bool,
    target: Pubkey,
    now: i64,
    loss: u64,
) {
    let id = vault.breaches.len() as u8;
    vault.breaches.push(Breach {
        breach_type,
        blocked,
        claimed: false,
        target,
        timestamp: now,
        loss,
    });
    emit!(BreachRecorded {
        breach_id: id,
        breach_type,
        target,
        loss,
        blocked
    });
    if vault.freeze_on_breach {
        vault.frozen = true;
    }
}

#[macro_export]
macro_rules! vault_seeds {
    ($vault:expr) => {
        [
            b"vault".as_ref(),
            $vault.guardian.as_ref(),
            &$vault.agent_id.to_le_bytes(),
            &[$vault.bump],
        ]
    };
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BreachType {
    UnauthorizedTarget,
    UnauthorizedApproval,
    UnauthorizedTransfer,
    Limit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct Breach {
    pub breach_type: BreachType,
    /// Enforce mode stopped the action; nothing was lost.
    pub blocked: bool,
    /// Set by the cover program once paid.
    pub claimed: bool,
    pub target: Pubkey,
    pub timestamp: i64,
    /// Base-asset units that left the vault in this call.
    pub loss: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VaultParams {
    pub agent_id: u64,
    pub agent: Pubkey,
    pub mandate_hash: [u8; 32],
    pub enforce: bool,
    pub freeze_on_breach: bool,
    pub allowed_programs: Vec<Pubkey>,
    pub max_outflow_per_call: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub cover_authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub guardian: Pubkey,
    pub agent: Pubkey,
    pub agent_id: u64,
    pub mandate_hash: [u8; 32],
    pub enforce: bool,
    pub freeze_on_breach: bool,
    pub base_mint: Pubkey,
    pub base_account: Pubkey,
    #[max_len(MAX_ALLOWED_PROGRAMS)]
    pub allowed_programs: Vec<Pubkey>,
    pub max_outflow_per_call: u64,
    pub frozen: bool,
    #[max_len(MAX_BREACHES)]
    pub breaches: Vec<Breach>,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// This program, so its upgrade authority can be checked: only the deployer may configure it.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::BondedVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ VaultError::NotDeployer)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: VaultParams)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = guardian,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", guardian.key().as_ref(), params.agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = guardian,
        seeds = [b"base", vault.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = vault,
    )]
    pub base_account: Account<'info, TokenAccount>,
    pub base_mint: Account<'info, Mint>,
    #[account(mut)]
    pub guardian: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(has_one = base_mint, has_one = base_account)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub base_account: Account<'info, TokenAccount>,
    pub base_mint: Account<'info, Mint>,
    #[account(mut, token::mint = base_mint)]
    pub from: Account<'info, TokenAccount>,
    pub depositor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(has_one = guardian, has_one = base_mint, has_one = base_account)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub base_account: Account<'info, TokenAccount>,
    pub base_mint: Account<'info, Mint>,
    #[account(mut, token::mint = base_mint)]
    pub to: Account<'info, TokenAccount>,
    pub guardian: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GuardianOnly<'info> {
    #[account(mut, has_one = guardian)]
    pub vault: Account<'info, Vault>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(mut, has_one = agent @ VaultError::NotAgent, has_one = base_account)]
    pub vault: Account<'info, Vault>,
    pub agent: Signer<'info>,
    #[account(mut)]
    pub base_account: Account<'info, TokenAccount>,
    /// CHECK: any executable program; `classify` checks it against the allowlist.
    #[account(executable)]
    pub target_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MarkClaimed<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = cover_authority @ VaultError::NotCoverAuthority)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub cover_authority: Signer<'info>,
}

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub agent_id: u64,
    pub guardian: Pubkey,
    pub agent: Pubkey,
    pub mandate_hash: [u8; 32],
}

#[event]
pub struct BreachRecorded {
    pub breach_id: u8,
    pub breach_type: BreachType,
    pub target: Pubkey,
    pub loss: u64,
    pub blocked: bool,
}

#[event]
pub struct BreachClaimed {
    pub vault: Pubkey,
    pub breach_id: u8,
}

#[event]
pub struct Frozen {
    pub vault: Pubkey,
}

#[event]
pub struct Unfrozen {
    pub vault: Pubkey,
}

#[event]
pub struct AgentRotated {
    pub vault: Pubkey,
    pub previous: Pubkey,
    pub new_agent: Pubkey,
}

#[error_code]
pub enum VaultError {
    #[msg("the vault is frozen")]
    Frozen,
    #[msg("only the program's upgrade authority can initialize it")]
    NotDeployer,
    #[msg("only the vault's agent can execute")]
    NotAgent,
    #[msg("the breach log is full")]
    BreachLogFull,
    #[msg("too many allowed programs")]
    TooManyPrograms,
    #[msg("the vault cannot call itself")]
    SelfCall,
    #[msg("no breach with that id")]
    UnknownBreach,
    #[msg("breach already claimed")]
    AlreadyClaimed,
    #[msg("only the cover program can mark breaches claimed")]
    NotCoverAuthority,
}
