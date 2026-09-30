//! End-to-end tests for the three Bonded programs on LiteSVM, with the compiled programs:
//! register → score → vault → pool → bond → cover → breach → claim, and the ways each step
//! must refuse. Every instruction comes from `bonded_client`, the builders the devnet runner
//! and keeper use, so these tests check those too. Run `anchor build` first; the tests load
//! `target/deploy/*.so`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::AccountDeserialize;
use bonded_client::{address, Attestation, BreachType, Quote, VaultParams, USD};
use litesvm::LiteSVM;
use litesvm_token::{get_spl_account, CreateAccount, CreateMint, MintTo};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::Account as TokenAccount;

const NOW: i64 = 1_800_000_000;
const MANDATE: [u8; 32] = [7; 32];
const TOKEN: Pubkey = bonded_client::TOKEN_PROGRAM;

/// A built program, read when the tests run so building the IDL doesn't need the binaries.
fn program_bytes(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../target/deploy/{name}.so",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}; run `anchor build` first"))
}

/// Make `authority` the upgrade authority of a program loaded by `add_program` (which leaves it
/// unset), the way a real deployment has one.
fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: &Pubkey) {
    let programdata = address::programdata(program);
    let mut acct = svm.get_account(&programdata).expect("programdata account");
    // ProgramData: 4-byte tag, 8-byte slot, then Option<Pubkey> (1-byte flag + 32 bytes).
    acct.data[12] = 1;
    acct.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(programdata, acct).unwrap();
}

/// Send one transaction; on failure return its logs, so a test can check which error it was.
fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
    let result = svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    result
}

fn expect_err(result: Result<(), String>, needle: &str) {
    let logs = result.expect_err("transaction should have failed");
    assert!(logs.contains(needle), "expected {needle} in logs:\n{logs}");
}

fn sign(signer: &Keypair, message: &[u8]) -> [u8; 64] {
    signer.sign_message(message).into()
}

fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    get_spl_account::<TokenAccount>(svm, account)
        .unwrap()
        .amount
}

fn account<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let data = svm.get_account(address).unwrap().data;
    T::try_deserialize(&mut &data[..]).unwrap()
}

struct World {
    svm: LiteSVM,
    admin: Keypair,
    attester: Keypair,
    operator: Keypair,
    agent: Keypair,
    underwriter: Keypair,
    mint: Pubkey,
    operator_usd: Pubkey,
    outsider_usd: Pubkey,
}

impl World {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        for (id, name) in [
            (bonded_registry::ID, "bonded_registry"),
            (bonded_vault::ID, "bonded_vault"),
            (bonded_cover::ID, "bonded_cover"),
        ] {
            svm.add_program(id, &program_bytes(name)).unwrap();
        }
        let mut clock: anchor_lang::prelude::Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);
        let (admin, attester, operator, agent, underwriter) = (
            Keypair::new(),
            Keypair::new(),
            Keypair::new(),
            Keypair::new(),
            Keypair::new(),
        );
        for id in [bonded_registry::ID, bonded_vault::ID, bonded_cover::ID] {
            set_upgrade_authority(&mut svm, &id, &admin.pubkey());
        }
        for k in [&admin, &operator, &agent, &underwriter] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let mint = CreateMint::new(&mut svm, &admin)
            .authority(&admin.pubkey())
            .decimals(6)
            .send()
            .unwrap();
        let operator_usd = CreateAccount::new(&mut svm, &admin, &mint)
            .owner(&operator.pubkey())
            .send()
            .unwrap();
        let underwriter_usd = CreateAccount::new(&mut svm, &admin, &mint)
            .owner(&underwriter.pubkey())
            .send()
            .unwrap();
        let outsider_usd = CreateAccount::new(&mut svm, &admin, &mint)
            .owner(&Pubkey::new_unique())
            .send()
            .unwrap();
        MintTo::new(&mut svm, &admin, &mint, &operator_usd, 100_000 * USD)
            .owner(&admin)
            .send()
            .unwrap();
        MintTo::new(&mut svm, &admin, &mint, &underwriter_usd, 1_000_000 * USD)
            .owner(&admin)
            .send()
            .unwrap();
        let mut w = World {
            svm,
            admin,
            attester,
            operator,
            agent,
            underwriter,
            mint,
            operator_usd,
            outsider_usd,
        };
        w.setup_programs(underwriter_usd);
        w
    }

    fn setup_programs(&mut self, underwriter_usd: Pubkey) {
        let admin = self.admin.insecure_clone();
        let ixs =
            bonded_client::initialize_all(&admin.pubkey(), &self.attester.pubkey(), &self.mint);
        send(&mut self.svm, &ixs, &admin, &[]).unwrap();

        // Register agent 1, owned by the operator.
        let operator = self.operator.insecure_clone();
        let register = bonded_client::register(&operator.pubkey(), 1, "ipfs://bonded/agent");
        send(&mut self.svm, &[register], &operator, &[]).unwrap();

        // An underwriter funds the pool with 1,000,000.
        let underwriter = self.underwriter.insecure_clone();
        let shares_to = CreateAccount::new(&mut self.svm, &admin, &address::share_mint())
            .owner(&underwriter.pubkey())
            .send()
            .unwrap();
        let deposit = bonded_client::pool_deposit(
            &self.mint,
            &underwriter_usd,
            &shares_to,
            &underwriter.pubkey(),
            1_000_000 * USD,
        );
        send(&mut self.svm, &[deposit], &underwriter, &[]).unwrap();
    }

    fn attestation(&self, issued_at: i64) -> Attestation {
        Attestation {
            agent_id: 1,
            score: 56,
            expected_loss_bps: 415,
            report_hash: [1; 32],
            mandate_hash: MANDATE,
            code_hash: [2; 32],
            tee_measurement: [0; 32],
            model_family: 0,
            issued_at,
            expires_at: NOW + 30 * 86_400,
        }
    }

    fn post_score_ixs(
        &self,
        attestation: &Attestation,
        signer: &Keypair,
        signed: &Attestation,
    ) -> Vec<Instruction> {
        let message = bonded_client::attestation_message(&bonded_registry::ID, signed);
        bonded_client::post_score(
            attestation,
            &signer.pubkey(),
            &sign(signer, &message),
            signed,
        )
        .to_vec()
    }

    fn create_vault(
        &mut self,
        enforce: bool,
        allowed: Vec<Pubkey>,
        agent_id: u64,
    ) -> (Pubkey, Pubkey) {
        let guardian = self.operator.pubkey();
        let vault = address::vault(&guardian, agent_id);
        let params = VaultParams {
            agent_id,
            agent: self.agent.pubkey(),
            mandate_hash: MANDATE,
            enforce,
            freeze_on_breach: true,
            allowed_programs: allowed,
            max_outflow_per_call: 5_000 * USD,
        };
        let create = bonded_client::create_vault(&guardian, &self.mint, params);
        let deposit = bonded_client::vault_deposit(
            &vault,
            &self.mint,
            &self.operator_usd,
            &guardian,
            50_000 * USD,
        );
        let operator = self.operator.insecure_clone();
        send(&mut self.svm, &[create, deposit], &operator, &[]).unwrap();
        (vault, address::vault_base(&vault))
    }

    /// The agent asks the vault to run `inner` (an instruction the vault signs).
    fn execute(&mut self, vault: Pubkey, _base: Pubkey, inner: Instruction) -> Result<(), String> {
        let ix = bonded_client::execute(&vault, &self.agent.pubkey(), inner);
        let agent = self.agent.insecure_clone();
        send(&mut self.svm, &[ix], &agent, &[])
    }

    fn transfer_out(&self, vault: Pubkey, base: Pubkey, to: Pubkey, amount: u64) -> Instruction {
        spl_token_interface::instruction::transfer_checked(
            &TOKEN,
            &base,
            &self.mint,
            &to,
            &vault,
            &[],
            amount,
            6,
        )
        .unwrap()
    }

    fn stake(&mut self, staker: &Keypair, from: Pubkey, amount: u64) -> Result<(), String> {
        let ix = bonded_client::stake(1, &self.mint, &from, &staker.pubkey(), amount);
        send(&mut self.svm, &[ix], staker, &[])
    }

    fn quote(&self, vault: Pubkey, nonce: u64) -> Quote {
        Quote {
            agent_id: 1,
            vault,
            cover_amount: 20_000 * USD,
            premium_rate_bps: 434,
            score: 56,
            min_bond: 500 * USD,
            mandate_hash: MANDATE,
            expires_at: NOW + 3_600,
            nonce,
        }
    }

    fn buy_cover(&mut self, quote: &Quote, signer: &Keypair, policy_id: u64) -> Result<(), String> {
        let message = bonded_client::quote_message(&bonded_cover::ID, quote);
        let ixs = bonded_client::buy_cover(
            quote,
            &signer.pubkey(),
            &sign(signer, &message),
            policy_id,
            &self.mint,
            &self.operator_usd,
            &self.operator.pubkey(),
        );
        let operator = self.operator.insecure_clone();
        send(&mut self.svm, &ixs, &operator, &[])
    }

    fn file_claim(
        &mut self,
        policy_id: u64,
        vault: Pubkey,
        _base: Pubkey,
        breaches: Vec<u8>,
    ) -> Result<(), String> {
        let ix = bonded_client::file_claim(policy_id, 1, &vault, &self.mint, breaches);
        // Anyone can file: the underwriter pays the fee here.
        let payer = self.underwriter.insecure_clone();
        send(&mut self.svm, &[ix], &payer, &[])
    }
}

#[test]
fn registry_accepts_only_the_attesters_signature_over_the_exact_attestation() {
    let mut w = World::new();
    let good = w.attestation(NOW - 10);
    let impostor = Keypair::new();
    let payer = w.admin.insecure_clone();

    let ixs = w.post_score_ixs(&good, &impostor, &good);
    expect_err(send(&mut w.svm, &ixs, &payer, &[]), "WrongSigner");

    // Signed attestation says score 56; the posted one claims 90.
    let mut inflated = good.clone();
    inflated.score = 90;
    let attester = w.attester.insecure_clone();
    let ixs = w.post_score_ixs(&inflated, &attester, &good);
    expect_err(send(&mut w.svm, &ixs, &payer, &[]), "WrongMessage");

    // No signature check before it.
    let ixs = w.post_score_ixs(&good, &attester, &good);
    expect_err(send(&mut w.svm, &ixs[1..], &payer, &[]), "MissingSignature");

    send(&mut w.svm, &ixs, &payer, &[]).unwrap();
    let agent: bonded_registry::Agent = account(&w.svm, &address::agent(1));
    assert_eq!(agent.score, Some(good.clone()));

    // An older (or equal) version can't replace it.
    let stale = w.attestation(NOW - 20);
    let ixs = w.post_score_ixs(&stale, &attester, &stale);
    expect_err(send(&mut w.svm, &ixs, &payer, &[]), "StaleScore");
}

#[test]
fn a_breach_is_recorded_frozen_and_paid_bond_first() {
    let mut w = World::new();
    let (vault, base) = w.create_vault(false, vec![TOKEN], 1);

    // Only the agent's registry owner can bond it.
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let admin = w.admin.insecure_clone();
    let stranger_usd = CreateAccount::new(&mut w.svm, &admin, &w.mint)
        .owner(&stranger.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut w.svm, &admin, &w.mint, &stranger_usd, 1_000 * USD)
        .owner(&admin)
        .send()
        .unwrap();
    expect_err(w.stake(&stranger, stranger_usd, 500 * USD), "NotAgentOwner");
    let operator = w.operator.insecure_clone();
    let from = w.operator_usd;
    w.stake(&operator, from, 500 * USD).unwrap();

    // A quote not signed by the attester is refused; a real one binds cover once.
    let quote = w.quote(vault, 1);
    expect_err(w.buy_cover(&quote, &Keypair::new(), 1), "WrongSigner");
    let attester = w.attester.insecure_clone();
    let before_premium = token_balance(&w.svm, &w.operator_usd);
    w.buy_cover(&quote, &attester, 1).unwrap();
    // 20,000 cover at 4.34% a year for 30 days = 71.34246575…, rounded up to 71.342466.
    assert_eq!(
        before_premium - token_balance(&w.svm, &w.operator_usd),
        71_342_466
    );
    assert!(
        w.buy_cover(&quote, &attester, 2).is_err(),
        "the same quote can't bind twice"
    );

    // The agent sends 1,000 to an outside account: recorded as a transfer breach, and frozen.
    let outsider = w.outsider_usd;
    let steal = w.transfer_out(vault, base, outsider, 1_000 * USD);
    w.execute(vault, base, steal).unwrap();
    assert_eq!(token_balance(&w.svm, &outsider), 1_000 * USD);
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert!(state.frozen);
    assert_eq!(state.breaches.len(), 1);
    assert_eq!(
        state.breaches[0].breach_type,
        BreachType::UnauthorizedTransfer
    );
    assert_eq!(state.breaches[0].loss, 1_000 * USD);
    let again = w.transfer_out(vault, base, outsider, USD);
    expect_err(w.execute(vault, base, again), "Frozen");

    // The claim pays 900 (10% deductible): all 500 of the bond first, then 400 from the pool.
    let pool = address::pool_vault();
    let pool_before = token_balance(&w.svm, &pool);
    w.file_claim(1, vault, base, vec![0]).unwrap();
    assert_eq!(token_balance(&w.svm, &base), (50_000 - 1_000 + 900) * USD);
    assert_eq!(pool_before - token_balance(&w.svm, &pool), 400 * USD);
    let bond: bonded_cover::Bond = account(&w.svm, &address::bond(1));
    assert_eq!(bond.amount, 0);
    let policy: bonded_cover::Policy = account(&w.svm, &address::policy(1));
    assert_eq!(policy.remaining_cover, 19_100 * USD);
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert!(state.breaches[0].claimed);

    // A breach is paid once.
    expect_err(w.file_claim(1, vault, base, vec![0]), "AlreadyClaimed");
}

#[test]
fn enforce_mode_blocks_the_action_and_still_freezes() {
    let mut w = World::new();
    let (vault, base) = w.create_vault(true, vec![TOKEN], 2);
    let outsider = w.outsider_usd;
    let steal = w.transfer_out(vault, base, outsider, 1_000 * USD);
    w.execute(vault, base, steal).unwrap();
    assert_eq!(
        token_balance(&w.svm, &base),
        50_000 * USD,
        "nothing left the vault"
    );
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert!(state.frozen);
    assert!(state.breaches[0].blocked);
    assert_eq!(state.breaches[0].loss, 0);
}

#[test]
fn programs_off_the_allowlist_and_oversized_calls_are_breaches() {
    let mut w = World::new();
    // The allowlist is empty, so even the token program is off it (Enforce, so nothing runs).
    let (vault, base) = w.create_vault(true, vec![], 3);
    let outsider = w.outsider_usd;
    let call = w.transfer_out(vault, base, outsider, USD);
    w.execute(vault, base, call).unwrap();
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert_eq!(
        state.breaches[0].breach_type,
        BreachType::UnauthorizedTarget
    );

    // Moving funds between the vault's own accounts is allowed and is not a loss, however large:
    // otherwise it could be claimed and then moved back.
    let (vault, base) = w.create_vault(false, vec![TOKEN], 4);
    let admin = w.admin.insecure_clone();
    let second = CreateAccount::new(&mut w.svm, &admin, &w.mint)
        .owner(&vault)
        .send()
        .unwrap();
    let small = w.transfer_out(vault, base, second, 1_000 * USD);
    w.execute(vault, base, small).unwrap();
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert!(
        state.breaches.is_empty() && !state.frozen,
        "an in-limit move to its own account is fine"
    );
    let big = w.transfer_out(vault, base, second, 6_000 * USD);
    w.execute(vault, base, big).unwrap();
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert!(
        state.breaches.is_empty() && !state.frozen,
        "a move between its own accounts is not a loss"
    );

    // Value that really leaves the vault is: burning 6,000 is over the 5,000 per-call limit.
    let burn = spl_token_interface::instruction::burn_checked(
        &TOKEN,
        &base,
        &w.mint,
        &vault,
        &[],
        6_000 * USD,
        6,
    )
    .unwrap();
    w.execute(vault, base, burn).unwrap();
    let state: bonded_vault::Vault = account(&w.svm, &vault);
    assert_eq!(state.breaches[0].breach_type, BreachType::Limit);
    assert_eq!(state.breaches[0].loss, 6_000 * USD);
    assert!(state.frozen);
}

#[test]
fn only_the_upgrade_authority_can_initialize_a_program() {
    let mut svm = LiteSVM::new();
    svm.add_program(bonded_registry::ID, &program_bytes("bonded_registry"))
        .unwrap();
    let deployer = Keypair::new();
    let front_runner = Keypair::new();
    for k in [&deployer, &front_runner] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    set_upgrade_authority(&mut svm, &bonded_registry::ID, &deployer.pubkey());
    // Only the registry's instruction matters here; the mint is unused by it.
    let init = |admin: &Keypair, attester: Pubkey| {
        bonded_client::initialize_all(&admin.pubkey(), &attester, &Pubkey::new_unique())[0].clone()
    };
    let evil = Pubkey::new_unique();
    expect_err(
        send(&mut svm, &[init(&front_runner, evil)], &front_runner, &[]),
        "NotDeployer",
    );
    send(
        &mut svm,
        &[init(&deployer, Pubkey::new_unique())],
        &deployer,
        &[],
    )
    .unwrap();
}

#[test]
fn a_deposit_into_an_emptied_pool_with_shares_outstanding_is_refused() {
    let mut w = World::new();
    // Simulate claims having drained the pool while the underwriter's shares remain.
    let pool = address::pool_vault();
    let mut acct = w.svm.get_account(&pool).unwrap();
    acct.data[64..72].copy_from_slice(&0u64.to_le_bytes());
    w.svm.set_account(pool, acct).unwrap();

    let shares = address::share_mint();
    let admin = w.admin.insecure_clone();
    let newcomer = Keypair::new();
    let shares_to = CreateAccount::new(&mut w.svm, &admin, &shares)
        .owner(&newcomer.pubkey())
        .send()
        .unwrap();
    let deposit = bonded_client::pool_deposit(
        &w.mint,
        &w.operator_usd,
        &shares_to,
        &w.operator.pubkey(),
        100 * USD,
    );
    let operator = w.operator.insecure_clone();
    expect_err(send(&mut w.svm, &[deposit], &operator, &[]), "PoolShort");
}
