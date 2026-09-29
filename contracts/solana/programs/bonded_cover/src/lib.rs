//! Bonded cover on Solana (docs/PLAN.md Sections 7 and 11). Mirrors `CoverPool`,
//! `OperatorBond`, `CoverManager` and `ClaimsEngine` on EVM:
//! - an underwriting pool with a share mint;
//! - first-loss operator bonds, staked only by the agent's registry owner;
//! - cover bound with a quote signed by the attester, only by the vault's guardian;
//! - permissionless parametric claims paid from the vault's breach log: bond first, then pool,
//!   less a 10% deductible, within a 7-day window after the policy ends.
//!
//! Not yet mirrored (Day 10): premiums are paid upfront for the term instead of streamed,
//! withdrawals have no cooldown, there is no per-agent or model-family cap, and a vault can
//! hold more than one active policy.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked};
use bonded_ed25519::INSTRUCTIONS_SYSVAR_ID;
use bonded_registry::Agent;
use bonded_vault::{program::BondedVault, Vault};

declare_id!("Dcrwfd272QQxXS4oEmHPSQdGWRZ2BMRSMb3Vi7jj6Y1X");

pub const QUOTE_DOMAIN: &[u8] = b"bonded-quote-v1";
pub const BPS: u64 = 10_000;
pub const YEAR: i64 = 365 * 24 * 60 * 60;
/// Scores below this are uninsurable (tier CCC), as `BondedTypes.tierRule`.
pub const MIN_INSURABLE_SCORE: u16 = 25;

#[program]
pub mod bonded_cover {
    use super::*;

    /// One-time setup: the pool's token account and share mint, and the attester whose quotes
    /// are accepted.
    pub fn initialize(ctx: Context<Initialize>, attester: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.attester = attester;
        config.base_mint = ctx.accounts.base_mint.key();
        config.deductible_bps = 1_000;
        config.claim_window = 7 * 24 * 60 * 60;
        config.policy_term = 30 * 24 * 60 * 60;
        config.max_leverage_bps = 20_000;
        config.total_active_cover = 0;
        config.next_policy_id = 1;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Underwriters deposit base asset for pool shares.
    pub fn deposit(ctx: Context<PoolDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, CoverError::ZeroAmount);
        let assets = ctx.accounts.pool_vault.amount;
        let supply = ctx.accounts.share_mint.supply;
        let shares = if supply == 0 || assets == 0 {
            amount
        } else {
            mul_div(amount, supply, assets)?
        };
        require!(shares > 0, CoverError::ZeroAmount);
        transfer_in(
            &ctx.accounts.token_program,
            &ctx.accounts.from,
            &ctx.accounts.base_mint,
            &ctx.accounts.pool_vault,
            &ctx.accounts.owner,
            amount,
        )?;
        let config = &ctx.accounts.config;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.shares_to.to_account_info(),
                    authority: config.to_account_info(),
                },
                &[&[b"config", &[config.bump]]],
            ),
            shares,
        )
    }

    /// Redeem shares for base asset, only from capital not backing active cover.
    pub fn withdraw(ctx: Context<PoolWithdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, CoverError::ZeroAmount);
        let assets = ctx.accounts.pool_vault.amount;
        let supply = ctx.accounts.share_mint.supply;
        let amount = mul_div(shares, assets, supply)?;
        let config = &ctx.accounts.config;
        let left = assets.checked_sub(amount).ok_or(CoverError::Overflow)?;
        require!(left >= required_capital(config)?, CoverError::CapitalLocked);
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.shares_from.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            shares,
        )?;
        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.pool_vault,
            &ctx.accounts.base_mint,
            &ctx.accounts.to.to_account_info(),
            config,
            amount,
        )
    }

    /// Stake a first-loss bond for an agent. Only the agent's registry owner can.
    pub fn stake(ctx: Context<Stake>, agent_id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, CoverError::ZeroAmount);
        require!(
            ctx.accounts.agent.agent_id == agent_id,
            CoverError::WrongAgent
        );
        let bond = &mut ctx.accounts.bond;
        if bond.agent_id == 0 {
            bond.agent_id = agent_id;
            bond.bump = ctx.bumps.bond;
        }
        bond.amount = bond
            .amount
            .checked_add(amount)
            .ok_or(CoverError::Overflow)?;
        transfer_in(
            &ctx.accounts.token_program,
            &ctx.accounts.from,
            &ctx.accounts.base_mint,
            &ctx.accounts.bond_vault,
            &ctx.accounts.operator,
            amount,
        )?;
        emit!(Staked { agent_id, amount });
        Ok(())
    }

    /// Bind cover with a quote the attester signed. The previous instruction must be an Ed25519
    /// check by the attester over `quote_message(program id, quote)`. Only the vault's guardian,
    /// who must also own the agent, can bind it. The premium for the whole term is paid now.
    pub fn buy_cover(ctx: Context<BuyCover>, quote: Quote) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault = &ctx.accounts.vault;
        let config = &ctx.accounts.config;
        require!(now <= quote.expires_at, CoverError::QuoteExpired);
        require!(quote.vault == vault.key(), CoverError::QuoteMismatch);
        require!(quote.agent_id == vault.agent_id, CoverError::QuoteMismatch);
        require!(
            quote.mandate_hash == vault.mandate_hash,
            CoverError::QuoteMismatch
        );
        require!(
            vault.base_mint == config.base_mint,
            CoverError::QuoteMismatch
        );
        require!(vault.freeze_on_breach, CoverError::VaultMustFreeze);
        require!(
            ctx.accounts.agent.owner == vault.guardian,
            CoverError::NotAgentOwner
        );
        require!(quote.cover_amount > 0, CoverError::ZeroAmount);
        require!(
            (MIN_INSURABLE_SCORE..=100).contains(&quote.score),
            CoverError::Uninsurable
        );
        require!(
            ctx.accounts.bond.amount >= quote.min_bond,
            CoverError::InsufficientBond
        );
        let capacity = mul_div(
            ctx.accounts.pool_vault.amount,
            u64::from(config.max_leverage_bps),
            BPS,
        )?;
        let active = config
            .total_active_cover
            .checked_add(quote.cover_amount)
            .ok_or(CoverError::Overflow)?;
        require!(active <= capacity, CoverError::CapacityExceeded);
        bonded_ed25519::require_signed(
            &ctx.accounts.instructions,
            &config.attester,
            &quote_message(&crate::ID, &quote),
        )?;

        let premium = premium_for(
            quote.cover_amount,
            quote.premium_rate_bps,
            config.policy_term,
        )?;
        transfer_in(
            &ctx.accounts.token_program,
            &ctx.accounts.premium_from,
            &ctx.accounts.base_mint,
            &ctx.accounts.pool_vault,
            &ctx.accounts.guardian,
            premium,
        )?;

        let config = &mut ctx.accounts.config;
        let policy = &mut ctx.accounts.policy;
        policy.policy_id = config.next_policy_id;
        policy.agent_id = quote.agent_id;
        policy.vault = quote.vault;
        policy.cover_amount = quote.cover_amount;
        policy.remaining_cover = quote.cover_amount;
        policy.premium_rate_bps = quote.premium_rate_bps;
        policy.score = quote.score;
        policy.started_at = now;
        policy.ends_at = now + config.policy_term;
        policy.active = true;
        policy.bump = ctx.bumps.policy;
        config.next_policy_id += 1;
        config.total_active_cover = active;
        ctx.accounts.quote_record.used = true;
        emit!(CoverBound {
            policy_id: policy.policy_id,
            vault: policy.vault,
            agent_id: policy.agent_id,
            cover_amount: policy.cover_amount,
            premium,
            ends_at: policy.ends_at,
        });
        Ok(())
    }

    /// Anyone can file a claim for unpaid breaches of a covered vault. The contract checks every
    /// breach against the vault's own log and pays: bond first, then pool, into the vault.
    pub fn file_claim(ctx: Context<FileClaim>, breach_ids: Vec<u8>) -> Result<()> {
        require!(!breach_ids.is_empty(), CoverError::NoBreaches);
        let now = Clock::get()?.unix_timestamp;
        let policy = &ctx.accounts.policy;
        let config = &ctx.accounts.config;
        require!(policy.active, CoverError::PolicyInactive);
        require!(
            now <= policy.ends_at + config.claim_window,
            CoverError::ClaimWindowClosed
        );

        // Read a copy of the vault instead of holding it as an Anchor account: the mark_claimed
        // call below writes it, and an Anchor account would overwrite that write when this
        // instruction ends. The account's owner is checked by the constraint; the discriminator
        // by try_deserialize.
        let vault: Vault = {
            let data = ctx.accounts.vault.try_borrow_data()?;
            Vault::try_deserialize(&mut &data[..])?
        };
        require!(
            ctx.accounts.vault.key() == policy.vault,
            CoverError::WrongVault
        );
        require!(
            ctx.accounts.vault_base.key() == vault.base_account,
            CoverError::WrongVault
        );
        let mut loss: u64 = 0;
        for (i, id) in breach_ids.iter().enumerate() {
            require!(!breach_ids[..i].contains(id), CoverError::DuplicateBreach);
            let breach = vault
                .breaches
                .get(usize::from(*id))
                .ok_or(CoverError::UnknownBreach)?;
            require!(!breach.claimed, CoverError::AlreadyClaimed);
            require!(!breach.blocked, CoverError::NothingLost);
            require!(
                breach.timestamp >= policy.started_at && breach.timestamp <= policy.ends_at,
                CoverError::NotCovered
            );
            loss = loss.checked_add(breach.loss).ok_or(CoverError::Overflow)?;
        }
        require!(loss > 0, CoverError::NothingLost);

        let payable =
            policy
                .remaining_cover
                .min(mul_div(loss, BPS - u64::from(config.deductible_bps), BPS)?);
        let from_bond = payable.min(ctx.accounts.bond.amount);
        let from_pool = payable - from_bond;
        require!(
            ctx.accounts.pool_vault.amount >= from_pool,
            CoverError::PoolShort
        );

        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.bond_vault,
            &ctx.accounts.base_mint,
            &ctx.accounts.vault_base.to_account_info(),
            config,
            from_bond,
        )?;
        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.pool_vault,
            &ctx.accounts.base_mint,
            &ctx.accounts.vault_base.to_account_info(),
            config,
            from_pool,
        )?;
        bonded_vault::cpi::mark_claimed(
            CpiContext::new_with_signer(
                ctx.accounts.vault_program.key(),
                bonded_vault::cpi::accounts::MarkClaimed {
                    config: ctx.accounts.vault_config.to_account_info(),
                    vault: ctx.accounts.vault.to_account_info(),
                    cover_authority: ctx.accounts.claims_authority.to_account_info(),
                },
                &[&[b"claims", &[ctx.bumps.claims_authority]]],
            ),
            breach_ids.clone(),
        )?;

        ctx.accounts.bond.amount -= from_bond;
        let policy = &mut ctx.accounts.policy;
        policy.remaining_cover -= payable;
        if policy.remaining_cover == 0 {
            policy.active = false;
        }
        let config = &mut ctx.accounts.config;
        config.total_active_cover = config.total_active_cover.saturating_sub(payable);
        emit!(ClaimPaid {
            policy_id: policy.policy_id,
            vault: policy.vault,
            loss,
            payout: payable,
            from_bond,
            from_pool,
            breach_ids,
        });
        Ok(())
    }

    /// After the term, anyone can close a policy to release the capacity it held. Breaches in
    /// the term stay claimable until the claim window closes.
    pub fn expire(ctx: Context<Expire>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let policy = &mut ctx.accounts.policy;
        require!(policy.active, CoverError::PolicyInactive);
        require!(
            now > policy.ends_at + ctx.accounts.config.claim_window,
            CoverError::StillOpen
        );
        policy.active = false;
        let config = &mut ctx.accounts.config;
        config.total_active_cover = config
            .total_active_cover
            .saturating_sub(policy.remaining_cover);
        Ok(())
    }
}

/// The exact bytes the attester signs for a quote: a domain prefix, this program's id and the
/// Borsh-encoded quote.
pub fn quote_message(program_id: &Pubkey, quote: &Quote) -> Vec<u8> {
    let mut message = Vec::with_capacity(QUOTE_DOMAIN.len() + 32 + 128);
    message.extend_from_slice(QUOTE_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    quote.serialize(&mut message).expect("vec write");
    message
}

/// Premium for `cover` over `term` seconds at an annual rate, rounded up so rounding never
/// undercharges the pool.
pub fn premium_for(cover: u64, rate_bps: u32, term: i64) -> Result<u64> {
    let numerator = u128::from(cover) * u128::from(rate_bps) * term as u128;
    let denominator = u128::from(BPS) * YEAR as u128;
    u64::try_from(numerator.div_ceil(denominator)).map_err(|_| error!(CoverError::Overflow))
}

/// Capital that must stay in the pool for the cover now active, rounded up.
pub fn required_capital(config: &Config) -> Result<u64> {
    let required = (u128::from(config.total_active_cover) * u128::from(BPS))
        .div_ceil(u128::from(config.max_leverage_bps));
    u64::try_from(required).map_err(|_| error!(CoverError::Overflow))
}

fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, CoverError::ZeroAmount);
    u64::try_from(u128::from(a) * u128::from(b) / u128::from(c))
        .map_err(|_| error!(CoverError::Overflow))
}

fn transfer_in<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

/// Pay out of an account the config PDA controls (pool or bond).
fn transfer_out<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &AccountInfo<'info>,
    config: &Account<'info, Config>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.clone(),
                authority: config.to_account_info(),
            },
            &[&[b"config", &[config.bump]]],
        ),
        amount,
        mint.decimals,
    )
}

/// Same fields as the EVM `BondedTypes.Quote` that matter on Solana.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct Quote {
    pub agent_id: u64,
    pub vault: Pubkey,
    pub cover_amount: u64,
    /// Annual premium, basis points of cover.
    pub premium_rate_bps: u32,
    pub score: u16,
    pub min_bond: u64,
    pub mandate_hash: [u8; 32],
    pub expires_at: i64,
    /// Chosen by the attester; each (vault, nonce) can be used once.
    pub nonce: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub attester: Pubkey,
    pub base_mint: Pubkey,
    pub deductible_bps: u16,
    pub claim_window: i64,
    pub policy_term: i64,
    pub max_leverage_bps: u32,
    pub total_active_cover: u64,
    pub next_policy_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bond {
    pub agent_id: u64,
    pub amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub policy_id: u64,
    pub agent_id: u64,
    pub vault: Pubkey,
    pub cover_amount: u64,
    pub remaining_cover: u64,
    pub premium_rate_bps: u32,
    pub score: u16,
    pub started_at: i64,
    pub ends_at: i64,
    pub active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct QuoteRecord {
    pub used: bool,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        seeds = [b"pool_vault"],
        bump,
        token::mint = base_mint,
        token::authority = config,
    )]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [b"shares"],
        bump,
        mint::decimals = base_mint.decimals,
        mint::authority = config,
    )]
    pub share_mint: Account<'info, Mint>,
    pub base_mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolDeposit<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = base_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"pool_vault"], bump)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"shares"], bump)]
    pub share_mint: Account<'info, Mint>,
    pub base_mint: Account<'info, Mint>,
    #[account(mut, token::mint = base_mint)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, token::mint = share_mint)]
    pub shares_to: Account<'info, TokenAccount>,
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PoolWithdraw<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = base_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"pool_vault"], bump)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"shares"], bump)]
    pub share_mint: Account<'info, Mint>,
    pub base_mint: Account<'info, Mint>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub shares_from: Account<'info, TokenAccount>,
    /// CHECK: any token account of the base mint; checked by the token program.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct Stake<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = base_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [b"agent", agent_id.to_le_bytes().as_ref()],
        seeds::program = bonded_registry::ID,
        bump = agent.bump,
        constraint = agent.owner == operator.key() @ CoverError::NotAgentOwner,
    )]
    pub agent: Box<Account<'info, Agent>>,
    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + Bond::INIT_SPACE,
        seeds = [b"bond", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bond: Box<Account<'info, Bond>>,
    #[account(
        init_if_needed,
        payer = operator,
        seeds = [b"bond_vault", agent_id.to_le_bytes().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = config,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = base_mint)]
    pub from: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(quote: Quote)]
pub struct BuyCover<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = base_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(has_one = guardian @ CoverError::NotGuardian)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        seeds = [b"agent", quote.agent_id.to_le_bytes().as_ref()],
        seeds::program = bonded_registry::ID,
        bump = agent.bump,
    )]
    pub agent: Box<Account<'info, Agent>>,
    #[account(seeds = [b"bond", quote.agent_id.to_le_bytes().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(
        init,
        payer = guardian,
        space = 8 + Policy::INIT_SPACE,
        seeds = [b"policy", config.next_policy_id.to_le_bytes().as_ref()],
        bump
    )]
    pub policy: Box<Account<'info, Policy>>,
    /// Exists once a quote is used, so the same quote can't bind cover twice.
    #[account(
        init,
        payer = guardian,
        space = 8 + QuoteRecord::INIT_SPACE,
        seeds = [b"quote", quote.vault.as_ref(), quote.nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub quote_record: Box<Account<'info, QuoteRecord>>,
    #[account(mut, seeds = [b"pool_vault"], bump)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = base_mint)]
    pub premium_from: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub guardian: Signer<'info>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FileClaim<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = base_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"policy", policy.policy_id.to_le_bytes().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,
    /// CHECK: the insured vault; read and checked against the policy in the handler.
    #[account(mut, owner = bonded_vault::ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the vault's base token account; checked against the vault in the handler.
    #[account(mut)]
    pub vault_base: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"bond", policy.agent_id.to_le_bytes().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(mut, seeds = [b"bond_vault", policy.agent_id.to_le_bytes().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"pool_vault"], bump)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub base_mint: Box<Account<'info, Mint>>,
    /// CHECK: signs `mark_claimed` for this program; the vault program checks its address.
    #[account(seeds = [b"claims"], bump)]
    pub claims_authority: UncheckedAccount<'info>,
    /// CHECK: the vault program's config, checked by that program.
    pub vault_config: UncheckedAccount<'info>,
    pub vault_program: Program<'info, BondedVault>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Expire<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"policy", policy.policy_id.to_le_bytes().as_ref()], bump = policy.bump)]
    pub policy: Account<'info, Policy>,
}

#[event]
pub struct Staked {
    pub agent_id: u64,
    pub amount: u64,
}

#[event]
pub struct CoverBound {
    pub policy_id: u64,
    pub vault: Pubkey,
    pub agent_id: u64,
    pub cover_amount: u64,
    pub premium: u64,
    pub ends_at: i64,
}

#[event]
pub struct ClaimPaid {
    pub policy_id: u64,
    pub vault: Pubkey,
    pub loss: u64,
    pub payout: u64,
    pub from_bond: u64,
    pub from_pool: u64,
    pub breach_ids: Vec<u8>,
}

#[error_code]
pub enum CoverError {
    #[msg("amount must be more than zero")]
    ZeroAmount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("withdrawal would take capital that backs active cover")]
    CapitalLocked,
    #[msg("the agent record is for a different agent")]
    WrongAgent,
    #[msg("only the agent's registry owner can do this")]
    NotAgentOwner,
    #[msg("only the vault's guardian can bind cover")]
    NotGuardian,
    #[msg("the quote has expired")]
    QuoteExpired,
    #[msg("the quote doesn't match this vault")]
    QuoteMismatch,
    #[msg("the vault must freeze on a breach")]
    VaultMustFreeze,
    #[msg("the score is too low to insure")]
    Uninsurable,
    #[msg("the operator bond is too small")]
    InsufficientBond,
    #[msg("the pool can't back this much cover")]
    CapacityExceeded,
    #[msg("no breaches given")]
    NoBreaches,
    #[msg("the policy is not active")]
    PolicyInactive,
    #[msg("the claim window has closed")]
    ClaimWindowClosed,
    #[msg("the vault is not the insured vault")]
    WrongVault,
    #[msg("a breach is listed twice")]
    DuplicateBreach,
    #[msg("no breach with that id")]
    UnknownBreach,
    #[msg("breach already claimed")]
    AlreadyClaimed,
    #[msg("nothing was lost")]
    NothingLost,
    #[msg("the breach is outside the policy term")]
    NotCovered,
    #[msg("the pool can't pay its share")]
    PoolShort,
    #[msg("the claim window is still open")]
    StillOpen,
}
