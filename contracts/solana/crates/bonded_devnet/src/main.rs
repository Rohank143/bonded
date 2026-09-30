//! Runs the Bonded Solana programs on devnet (docs/PLAN.md Section 20, Day 10: "Solana E2E
//! breach → claim on devnet").
//!
//! - `bonded-devnet setup`: once, and safe to repeat. Creates a test-USD mint, initializes the
//!   three programs, funds the test accounts and seeds the pool. Writes the deployment file.
//! - `bonded-devnet e2e [evidence.json]`: a new agent each run: register → score → vault →
//!   bond → cover → breach → claim, with checks on the payout, and an explorer link per step.
//!
//! The deployer (`~/.config/solana/id.json`, or `SOLANA_KEYPAIR`) is each program's upgrade
//! authority and the mint authority. The other test keys live in `BONDED_SOLANA_KEYS`
//! (default `~/.config/bonded/solana-devnet`), outside the repository. Devnet only: the mint is
//! a test token with no value.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, Owner};
use bonded_client::{address, Attestation, Quote, VaultParams, TOKEN_PROGRAM, USD};
use serde_json::{json, Value};
use solana_commitment_config::CommitmentConfig;
use solana_keypair::{read_keypair_file, write_keypair_file, Keypair};
use solana_program_pack::Pack;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;

mod cluster;
mod deployment;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const RPC_URL: &str = "https://api.devnet.solana.com";
/// Any placeholder mandate: the vault stores its hash; nothing on chain reads the text.
const MANDATE: [u8; 32] = [7; 32];
const SOL: u64 = 1_000_000_000;

struct Devnet {
    rpc: RpcClient,
    /// "devnet", or "localnet" for a local validator (rehearsals).
    cluster: &'static str,
    admin: Keypair,
    attester: Keypair,
    operator: Keypair,
    agent: Keypair,
    underwriter: Keypair,
    mint: Keypair,
    steps: Vec<Value>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME is set"))
}

/// Load a key from the keys folder, creating it on first use.
fn test_key(dir: &Path, name: &str) -> Result<Keypair> {
    let path = dir.join(format!("{name}.json"));
    if path.exists() {
        return read_keypair_file(&path).map_err(|e| format!("{}: {e}", path.display()).into());
    }
    let key = Keypair::new();
    write_keypair_file(&key, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    println!("created {name} key {}", key.pubkey());
    Ok(key)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after 1970")
        .as_secs() as i64
}

fn explorer(cluster: &str, signature: &str) -> String {
    match cluster {
        "devnet" => format!("https://explorer.solana.com/tx/{signature}?cluster=devnet"),
        _ => signature.to_string(),
    }
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_PROGRAM)
}

impl Devnet {
    fn connect() -> Result<Self> {
        let rpc_url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| RPC_URL.into());
        cluster::validate_rpc_url(&rpc_url)?;
        let rpc = RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::confirmed());
        let genesis = rpc.get_genesis_hash().map_err(|_| {
            "could not verify the RPC genesis hash; check SOLANA_RPC_URL and connectivity"
        })?;
        let cluster = cluster::verify_cluster(&rpc_url, &genesis.to_string())?;
        let admin_path = std::env::var("SOLANA_KEYPAIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".config/solana/id.json"));
        let admin =
            read_keypair_file(&admin_path).map_err(|e| format!("{}: {e}", admin_path.display()))?;
        let dir = std::env::var("BONDED_SOLANA_KEYS")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".config/bonded/solana-devnet"));
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            rpc,
            cluster,
            admin,
            attester: test_key(&dir, "attester")?,
            operator: test_key(&dir, "operator")?,
            agent: test_key(&dir, "agent")?,
            underwriter: test_key(&dir, "underwriter")?,
            mint: test_key(&dir, "usd-mint")?,
            steps: vec![],
        })
    }

    /// Send one transaction and record it. `payer` pays and signs; `signers` also sign.
    fn send(
        &mut self,
        step: &str,
        ixs: &[Instruction],
        payer: &Keypair,
        signers: &[&Keypair],
    ) -> Result<String> {
        let blockhash = self.rpc.get_latest_blockhash()?;
        let mut all: Vec<&Keypair> = vec![payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, blockhash);
        let signature = self
            .rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| format!("{step}: {e}"))?
            .to_string();
        let link = explorer(self.cluster, &signature);
        println!("  {step:<34} {link}");
        self.steps
            .push(json!({ "step": step, "signature": signature, "explorer": link }));
        Ok(signature)
    }

    fn read<T: AccountDeserialize + Owner>(&self, account: &Pubkey) -> Result<T> {
        deployment::read(&self.rpc, account)
    }

    fn deployment(&self) -> Result<deployment::Deployment> {
        deployment::verify(
            &self.rpc,
            &self.admin.pubkey(),
            &self.attester.pubkey(),
            &self.mint.pubkey(),
        )
    }

    fn token_balance(&self, account: &Pubkey) -> Result<u64> {
        Ok(self
            .rpc
            .get_token_account_balance(account)?
            .amount
            .parse()?)
    }

    /// Top an account up to `lamports` from the deployer.
    fn fund(&mut self, who: &Pubkey, lamports: u64, step: &str) -> Result<()> {
        let balance = self.rpc.get_balance(who)?;
        if balance >= lamports {
            return Ok(());
        }
        let ix = solana_system_interface::instruction::transfer(
            &self.admin.pubkey(),
            who,
            lamports - balance,
        );
        let admin = self.admin.insecure_clone();
        self.send(step, &[ix], &admin, &[])?;
        Ok(())
    }

    fn mint_usd(&mut self, to_owner: &Pubkey, amount: u64, step: &str) -> Result<Pubkey> {
        let mint = self.mint.pubkey();
        let account = ata(to_owner, &mint);
        let admin = self.admin.insecure_clone();
        let ixs = [
            create_associated_token_account_idempotent(
                &admin.pubkey(),
                to_owner,
                &mint,
                &TOKEN_PROGRAM,
            ),
            spl_token_interface::instruction::mint_to(
                &TOKEN_PROGRAM,
                &mint,
                &account,
                &admin.pubkey(),
                &[],
                amount,
            )?,
        ];
        self.send(step, &ixs, &admin, &[])?;
        Ok(account)
    }

    fn setup(&mut self) -> Result<()> {
        println!(
            "Setting up Bonded on {} as {}",
            self.cluster,
            self.admin.pubkey()
        );
        // Read and validate all existing state before funding, minting or initialization.
        let existing = self.deployment()?;
        let (operator, agent, underwriter) = (
            self.operator.pubkey(),
            self.agent.pubkey(),
            self.underwriter.pubkey(),
        );
        self.fund(&operator, SOL / 5, "fund operator")?;
        self.fund(&agent, SOL / 50, "fund agent")?;
        self.fund(&underwriter, SOL / 20, "fund underwriter")?;

        let mint = self.mint.pubkey();
        if !existing.mint_exists {
            let space = spl_token_interface::state::Mint::LEN;
            let rent = self.rpc.get_minimum_balance_for_rent_exemption(space)?;
            let admin = self.admin.insecure_clone();
            let mint_key = self.mint.insecure_clone();
            let ixs = [
                solana_system_interface::instruction::create_account(
                    &admin.pubkey(),
                    &mint,
                    rent,
                    space as u64,
                    &TOKEN_PROGRAM,
                ),
                spl_token_interface::instruction::initialize_mint2(
                    &TOKEN_PROGRAM,
                    &mint,
                    &admin.pubkey(),
                    None,
                    6,
                )?,
            ];
            self.send("create test-USD mint", &ixs, &admin, &[&mint_key])?;
        }

        // Initialize whichever programs aren't yet.
        let missing_configs = [
            existing.registry.is_none(),
            existing.vault.is_none(),
            existing.cover.is_none(),
        ];
        let init =
            bonded_client::initialize_all(&self.admin.pubkey(), &self.attester.pubkey(), &mint);
        let mut missing = vec![];
        for (is_missing, ix) in missing_configs.into_iter().zip(init) {
            if is_missing {
                missing.push(ix);
            }
        }
        if !missing.is_empty() {
            let admin = self.admin.insecure_clone();
            self.send("initialize programs", &missing, &admin, &[])?;
        }
        // Seed the pool once with 1,000,000 test USD.
        if !matches!(existing.pool, deployment::PoolState::Funded) {
            // Validate the initialized state again before minting the seed deposit.
            let initialized = self.deployment()?;
            initialized.require_initialized()?;
            if !matches!(initialized.pool, deployment::PoolState::Funded) {
                let from = self.mint_usd(&underwriter, 1_000_000 * USD, "mint to underwriter")?;
                let shares_to = ata(&underwriter, &address::share_mint());
                let uw = self.underwriter.insecure_clone();
                let ixs = [
                    create_associated_token_account_idempotent(
                        &underwriter,
                        &underwriter,
                        &address::share_mint(),
                        &TOKEN_PROGRAM,
                    ),
                    bonded_client::pool_deposit(
                        &mint,
                        &from,
                        &shares_to,
                        &underwriter,
                        1_000_000 * USD,
                    ),
                ];
                self.send("underwriter funds the pool", &ixs, &uw, &[])?;
            }
        }

        // Record observed, verified chain state, including after a partial setup was resumed.
        let observed = self.deployment()?;
        observed.require_initialized()?;
        let cover = observed
            .cover
            .ok_or("cover config is missing after setup")?;
        let deployment = json!({
            "cluster": self.cluster,
            "programs": {
                "bonded_registry": bonded_registry::ID.to_string(),
                "bonded_vault": bonded_vault::ID.to_string(),
                "bonded_cover": bonded_cover::ID.to_string(),
            },
            "upgradeAuthority": observed.upgrade_authority.to_string(),
            "attester": cover.attester.to_string(),
            "testUsdMint": cover.base_mint.to_string(),
            "pool": address::pool_vault().to_string(),
        });
        // The deployment record, committed like the EVM ones: addresses only, no keys.
        let path = format!("deployments/{}.json", self.cluster);
        std::fs::create_dir_all("deployments")?;
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&deployment)?),
        )?;
        println!("Set up. Deployment written to {path}");
        Ok(())
    }

    fn e2e(&mut self, evidence: Option<&str>, leave_claim: bool) -> Result<()> {
        let observed = self.deployment()?;
        observed.require_initialized()?;
        if !matches!(observed.pool, deployment::PoolState::Funded) {
            return Err("pool is not seeded: run `bonded-devnet setup` first".into());
        }
        let mint = self.mint.pubkey();
        let registry = observed.registry.ok_or("registry config is missing")?;
        let agent_id = registry.agent_count + 1;
        let (operator, agent) = (self.operator.pubkey(), self.agent.pubkey());
        let op = self.operator.insecure_clone();
        let admin = self.admin.insecure_clone();
        println!("End-to-end run on {} for agent {agent_id}", self.cluster);
        self.fund(&operator, SOL / 5, "top up operator")?;
        self.fund(&agent, SOL / 50, "top up agent")?;

        // 1. The operator registers the agent and the attester's score is posted.
        let operator_usd = self.mint_usd(&operator, 51_000 * USD, "mint test USD to operator")?;
        self.send(
            "register agent",
            &[bonded_client::register(
                &operator,
                agent_id,
                "bonded://devnet/e2e",
            )],
            &op,
            &[],
        )?;
        let attestation = Attestation {
            agent_id,
            score: 56,
            expected_loss_bps: 415,
            report_hash: [1; 32],
            mandate_hash: MANDATE,
            code_hash: [2; 32],
            tee_measurement: [0; 32],
            model_family: 0,
            issued_at: now() - 60,
            expires_at: now() + 30 * 86_400,
        };
        let message = bonded_client::attestation_message(&bonded_registry::ID, &attestation);
        let signature: [u8; 64] = self.attester.sign_message(&message).into();
        let ixs = bonded_client::post_score(
            &attestation,
            &self.attester.pubkey(),
            &signature,
            &attestation,
        );
        self.send("post signed score", &ixs, &admin, &[])?;

        // 2. A vault in Monitor mode holding 50,000, a 500 bond, and 20,000 of cover.
        let vault = address::vault(&operator, agent_id);
        let base = address::vault_base(&vault);
        let params = VaultParams {
            agent_id,
            agent,
            mandate_hash: MANDATE,
            enforce: false,
            freeze_on_breach: true,
            allowed_programs: vec![TOKEN_PROGRAM],
            max_outflow_per_call: 5_000 * USD,
        };
        let ixs = [
            bonded_client::create_vault(&operator, &mint, params),
            bonded_client::vault_deposit(&vault, &mint, &operator_usd, &operator, 50_000 * USD),
        ];
        self.send("create vault, deposit 50,000", &ixs, &op, &[])?;
        let ix = bonded_client::stake(agent_id, &mint, &operator_usd, &operator, 500 * USD);
        self.send("operator bonds 500", &[ix], &op, &[])?;
        let cover: bonded_cover::Config = self.read(&address::cover_config())?;
        let policy_id = cover.next_policy_id;
        let quote = Quote {
            agent_id,
            vault,
            cover_amount: 20_000 * USD,
            premium_rate_bps: 434,
            score: 56,
            min_bond: 500 * USD,
            mandate_hash: MANDATE,
            expires_at: now() + 3_600,
            nonce: 1,
        };
        let message = bonded_client::quote_message(&bonded_cover::ID, &quote);
        let signature: [u8; 64] = self.attester.sign_message(&message).into();
        let ixs = bonded_client::buy_cover(
            &quote,
            &self.attester.pubkey(),
            &signature,
            policy_id,
            &mint,
            &operator_usd,
            &operator,
        );
        self.send("buy cover with signed quote", &ixs, &op, &[])?;

        // 3. The agent sends 1,000 out of the vault: a breach, recorded and frozen.
        let outsider = Keypair::new().pubkey();
        let outsider_usd = ata(&outsider, &mint);
        let ix = create_associated_token_account_idempotent(
            &admin.pubkey(),
            &outsider,
            &mint,
            &TOKEN_PROGRAM,
        );
        self.send("outsider token account", &[ix], &admin, &[])?;
        let steal = spl_token_interface::instruction::transfer_checked(
            &TOKEN_PROGRAM,
            &base,
            &mint,
            &outsider_usd,
            &vault,
            &[],
            1_000 * USD,
            6,
        )?;
        let ag = self.agent.insecure_clone();
        self.send(
            "agent sends 1,000 out (breach)",
            &[bonded_client::execute(&vault, &agent, steal)],
            &ag,
            &[],
        )?;
        let state: bonded_vault::Vault = self.read(&vault)?;
        let breach = state.breaches.first().ok_or("no breach recorded")?;
        check(state.frozen, "the vault froze")?;
        check(
            breach.loss == 1_000 * USD,
            "the breach records a 1,000 loss",
        )?;

        // With --leave-claim, stop here: the keeper (apps/keeper, SolanaKeeper) must find and
        // file this claim on its own.
        if leave_claim {
            println!(
                "Left the claim for the keeper: policy {policy_id}, agent {agent_id}, vault {vault}"
            );
            return Ok(());
        }

        // 4. Anyone files the claim: 900 back to the vault (10% deductible), bond first.
        let pool_before = self.token_balance(&address::pool_vault())?;
        let ix = bonded_client::file_claim(policy_id, agent_id, &vault, &mint, vec![0]);
        self.send("file claim", &[ix], &admin, &[])?;
        let base_after = self.token_balance(&base)?;
        let pool_paid = pool_before - self.token_balance(&address::pool_vault())?;
        let bond: bonded_cover::Bond = self.read(&address::bond(agent_id))?;
        let policy: bonded_cover::Policy = self.read(&address::policy(policy_id))?;
        let state: bonded_vault::Vault = self.read(&vault)?;
        check(
            base_after == (50_000 - 1_000 + 900) * USD,
            "the vault got 900 back",
        )?;
        check(bond.amount == 0, "the 500 bond paid first")?;
        check(pool_paid == 400 * USD, "the pool paid the other 400")?;
        check(
            policy.remaining_cover == 19_100 * USD,
            "cover left is 19,100",
        )?;
        check(state.breaches[0].claimed, "the breach is marked claimed")?;
        println!("Breach → claim on {}: all checks passed.", self.cluster);

        if let Some(path) = evidence {
            let record = json!({
                "cluster": self.cluster,
                "ranAt": now(),
                "agentId": agent_id,
                "policyId": policy_id,
                "vault": vault.to_string(),
                "checks": {
                    "vaultFrozen": true,
                    "breachLossUsd": 1_000,
                    "claimPaidUsd": 900,
                    "fromBondUsd": 500,
                    "fromPoolUsd": 400,
                    "remainingCoverUsd": 19_100,
                },
                "steps": self.steps,
            });
            std::fs::write(
                path,
                format!("{}\n", serde_json::to_string_pretty(&record)?),
            )?;
            println!("Evidence written to {path}");
        }
        Ok(())
    }
}

fn check(ok: bool, what: &str) -> Result<()> {
    if ok {
        println!("  ok: {what}");
        Ok(())
    } else {
        Err(format!("check failed: {what}").into())
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if !matches!(args.get(1).map(String::as_str), Some("setup" | "e2e")) {
        eprintln!("Usage: bonded-devnet setup | bonded-devnet e2e [evidence.json] [--leave-claim]");
        std::process::exit(1);
    }
    let mut devnet = Devnet::connect()?;
    match args.get(1).map(String::as_str) {
        Some("setup") => devnet.setup(),
        Some("e2e") => {
            let leave_claim = args.iter().any(|a| a == "--leave-claim");
            let evidence = args[2..].iter().find(|a| !a.starts_with("--"));
            devnet.e2e(evidence.map(String::as_str), leave_claim)
        }
        _ => unreachable!("command validated before connecting"),
    }
}
