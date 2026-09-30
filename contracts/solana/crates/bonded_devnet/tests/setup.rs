//! CLI regressions against a local RPC with synthetic keys. Incompatible existing deployments
//! must be rejected before funds move or deployment metadata is overwritten. Valid transitions
//! may reach transaction preparation; the mock refuses every transaction-related method.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use base64::{engine::general_purpose::STANDARD, Engine};
use bonded_client::{address, TOKEN_PROGRAM, USD};
use serde_json::{json, Value};
use solana_keypair::{write_keypair_file, Keypair};
use solana_program_pack::Pack;
use solana_signer::Signer;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};
use tempfile::TempDir;

const SAVED_DEPLOYMENT: &str = "{\"existingDeployment\":\"preserve on failure\"}\n";

#[derive(Clone)]
struct RpcAccount {
    owner: Pubkey,
    executable: bool,
    data: Vec<u8>,
}

impl RpcAccount {
    fn json(&self) -> Value {
        json!({
            "owner": self.owner.to_string(),
            "executable": self.executable,
            "lamports": 10_000_000,
            "rentEpoch": 0,
            "space": self.data.len(),
            "data": [STANDARD.encode(&self.data), "base64"],
        })
    }
}

struct Fixture {
    dir: TempDir,
    admin: Pubkey,
    attester: Pubkey,
    mint: Pubkey,
    accounts: HashMap<Pubkey, RpcAccount>,
    /// Invalid fixtures are unfunded, proving preflight finishes before any attempted top-up.
    funded: bool,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("keys");
        std::fs::create_dir(&keys).unwrap();
        let mut public = HashMap::new();
        for name in [
            "admin",
            "attester",
            "operator",
            "agent",
            "underwriter",
            "usd-mint",
        ] {
            let key = Keypair::new();
            write_keypair_file(&key, keys.join(format!("{name}.json"))).unwrap();
            public.insert(name, key.pubkey());
        }
        std::fs::create_dir(dir.path().join("deployments")).unwrap();
        std::fs::write(
            dir.path().join("deployments/localnet.json"),
            SAVED_DEPLOYMENT,
        )
        .unwrap();
        let mut fixture = Self {
            dir,
            admin: public["admin"],
            attester: public["attester"],
            mint: public["usd-mint"],
            accounts: HashMap::new(),
            funded: false,
        };
        for program in [bonded_registry::ID, bonded_vault::ID, bonded_cover::ID] {
            let programdata = address::programdata(&program);
            // UpgradeableLoaderState::Program: enum tag followed by its ProgramData address.
            let mut data = 2u32.to_le_bytes().to_vec();
            data.extend_from_slice(programdata.as_ref());
            fixture.accounts.insert(
                program,
                RpcAccount {
                    owner: bpf_loader_upgradeable::ID,
                    executable: true,
                    data,
                },
            );
            fixture.set_upgrade_authority(program, fixture.admin);
        }
        fixture.put_anchor(
            address::registry_config(),
            bonded_registry::ID,
            &bonded_registry::Config {
                admin: fixture.admin,
                attester: fixture.attester,
                agent_count: 1,
                bump: config_bump(&bonded_registry::ID),
            },
        );
        fixture.put_anchor(
            address::vault_config(),
            bonded_vault::ID,
            &bonded_vault::Config {
                admin: fixture.admin,
                cover_authority: address::claims_authority(),
                bump: config_bump(&bonded_vault::ID),
            },
        );
        fixture.put_anchor(
            address::cover_config(),
            bonded_cover::ID,
            &bonded_cover::Config {
                admin: fixture.admin,
                attester: fixture.attester,
                base_mint: fixture.mint,
                deductible_bps: 1_000,
                claim_window: 7 * 86_400,
                policy_term: 30 * 86_400,
                max_leverage_bps: 20_000,
                total_active_cover: 19_100 * USD,
                next_policy_id: 2,
                bump: config_bump(&bonded_cover::ID),
            },
        );
        fixture.put_mint(
            fixture.mint,
            Mint {
                mint_authority: Some(fixture.admin).into(),
                supply: 1_051_000 * USD,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
        );
        fixture.put_mint(
            address::share_mint(),
            Mint {
                mint_authority: Some(address::cover_config()).into(),
                supply: 1_000_000 * USD,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
        );
        fixture.put_pool(TokenAccount {
            mint: fixture.mint,
            owner: address::cover_config(),
            amount: 999_671_342_466,
            delegate: None.into(),
            state: AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        });
        fixture
    }

    fn put_anchor<T: AccountSerialize>(&mut self, key: Pubkey, owner: Pubkey, value: &T) {
        let mut data = vec![];
        value.try_serialize(&mut data).unwrap();
        self.accounts.insert(
            key,
            RpcAccount {
                owner,
                executable: false,
                data,
            },
        );
    }

    fn edit_anchor<T: AccountDeserialize + AccountSerialize>(
        &mut self,
        key: Pubkey,
        edit: impl FnOnce(&mut T),
    ) {
        let account = &mut self.accounts.get_mut(&key).unwrap();
        let mut value = T::try_deserialize(&mut &account.data[..]).unwrap();
        edit(&mut value);
        account.data.clear();
        value.try_serialize(&mut account.data).unwrap();
    }

    fn put_mint(&mut self, key: Pubkey, value: Mint) {
        let mut data = vec![0; Mint::LEN];
        Mint::pack(value, &mut data).unwrap();
        self.accounts.insert(
            key,
            RpcAccount {
                owner: TOKEN_PROGRAM,
                executable: false,
                data,
            },
        );
    }

    fn edit_mint(&mut self, key: Pubkey, edit: impl FnOnce(&mut Mint)) {
        let mut value = Mint::unpack_unchecked(&self.accounts[&key].data).unwrap();
        edit(&mut value);
        self.put_mint(key, value);
    }

    fn put_pool(&mut self, value: TokenAccount) {
        let mut data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(value, &mut data).unwrap();
        self.accounts.insert(
            address::pool_vault(),
            RpcAccount {
                owner: TOKEN_PROGRAM,
                executable: false,
                data,
            },
        );
    }

    fn edit_pool(&mut self, edit: impl FnOnce(&mut TokenAccount)) {
        let mut value = TokenAccount::unpack(&self.accounts[&address::pool_vault()].data).unwrap();
        edit(&mut value);
        self.put_pool(value);
    }

    fn set_unseeded_pool(&mut self) {
        self.edit_pool(|pool| pool.amount = 0);
        self.edit_mint(address::share_mint(), |shares| shares.supply = 0);
        self.edit_mint(self.mint, |mint| mint.supply = 0);
        self.edit_anchor::<bonded_cover::Config>(address::cover_config(), |config| {
            config.total_active_cover = 0;
            config.next_policy_id = 1;
        });
    }

    fn set_upgrade_authority(&mut self, program: Pubkey, admin: Pubkey) {
        // UpgradeableLoaderState::ProgramData: enum tag, slot, Some(authority), then bytecode.
        let mut data = 3u32.to_le_bytes().to_vec();
        data.extend_from_slice(&1u64.to_le_bytes());
        data.push(1);
        data.extend_from_slice(admin.as_ref());
        data.extend_from_slice(b"\x7fELFfixture");
        self.accounts.insert(
            address::programdata(&program),
            RpcAccount {
                owner: bpf_loader_upgradeable::ID,
                executable: false,
                data,
            },
        );
    }

    fn run(&self, command: &str) -> (Output, Vec<String>) {
        let rpc = MockRpc::start(self.accounts.clone(), self.funded);
        let binary = std::env::var("BONDED_DEVNET_TEST_BINARY")
            .unwrap_or_else(|_| env!("CARGO_BIN_EXE_bonded-devnet").into());
        let output = Command::new(binary)
            .arg(command)
            .current_dir(self.dir.path())
            .env("SOLANA_KEYPAIR", self.dir.path().join("keys/admin.json"))
            .env("BONDED_SOLANA_KEYS", self.dir.path().join("keys"))
            .env("SOLANA_RPC_URL", format!("http://{}", rpc.addr))
            .output()
            .unwrap();
        let methods = rpc.methods.lock().unwrap().clone();
        (output, methods)
    }

    fn rejected(&self, command: &str, expected: &str) {
        let (output, methods) = self.run(command);
        let diagnostic = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !output.status.success(),
            "incompatible deployment accepted:\n{diagnostic}"
        );
        assert!(
            diagnostic.to_lowercase().contains(expected),
            "expected {expected:?} diagnosis:\n{diagnostic}"
        );
        assert_read_only(&methods);
        assert!(
            !methods.iter().any(|method| method == "getLatestBlockhash"),
            "prepared a transaction before rejecting deployment: {methods:?}"
        );
        assert_eq!(
            std::fs::read_to_string(self.dir.path().join("deployments/localnet.json")).unwrap(),
            SAVED_DEPLOYMENT
        );
    }

    fn reaches_initialization(&self, expected_method: &str) {
        let (output, methods) = self.run("setup");
        let diagnostic = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output.status.success(), "mock must refuse writes");
        assert!(
            methods.iter().any(|method| method == expected_method),
            "valid deployment did not reach {expected_method}: {methods:?}\n{diagnostic}"
        );
        assert!(
            diagnostic.contains(&format!("read-only mock refuses {expected_method}")),
            "setup failed before the mock stopped initialization:\n{diagnostic}"
        );
        assert!(
            !methods.iter().any(|method| matches!(
                method.as_str(),
                "sendTransaction" | "simulateTransaction" | "requestAirdrop"
            )),
            "attempted a transaction: {methods:?}"
        );
        assert_eq!(
            std::fs::read_to_string(self.dir.path().join("deployments/localnet.json")).unwrap(),
            SAVED_DEPLOYMENT
        );
    }
}

fn config_bump(program: &Pubkey) -> u8 {
    Pubkey::find_program_address(&[b"config"], program).1
}

struct MockRpc {
    addr: SocketAddr,
    methods: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MockRpc {
    fn start(accounts: HashMap<Pubkey, RpcAccount>, funded: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let methods = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let recorded = Arc::clone(&methods);
        let stopping = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            for connection in listener.incoming() {
                if stopping.load(Ordering::Relaxed) {
                    break;
                }
                let mut stream = connection.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let request = read_request(&mut stream);
                let method = request["method"].as_str().unwrap();
                recorded.lock().unwrap().push(method.to_owned());
                let context = |value| json!({ "context": { "slot": 1 }, "value": value });
                let account = |key: &Value| {
                    key.as_str()
                        .and_then(|key| key.parse::<Pubkey>().ok())
                        .and_then(|key| accounts.get(&key))
                        .map_or(Value::Null, RpcAccount::json)
                };
                let result = match method {
                    "getGenesisHash" => Some(json!("11111111111111111111111111111111")),
                    "getVersion" => Some(json!({ "solana-core": "3.0.0", "feature-set": 1 })),
                    "getAccountInfo" => Some(context(account(&request["params"][0]))),
                    "getMultipleAccounts" => Some(context(Value::Array(
                        request["params"][0]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(account)
                            .collect(),
                    ))),
                    "getBalance" => Some(context(json!(if funded { 1_000_000_000u64 } else { 0 }))),
                    "getTokenAccountBalance" => {
                        let key: Pubkey = request["params"][0].as_str().unwrap().parse().unwrap();
                        let token = TokenAccount::unpack(&accounts[&key].data).unwrap();
                        Some(context(
                            json!({ "amount": token.amount.to_string(), "decimals": 6,
                            "uiAmount": token.amount as f64 / USD as f64,
                            "uiAmountString": format!("{:.6}", token.amount as f64 / USD as f64) }),
                        ))
                    }
                    _ => None,
                };
                let response = match result {
                    Some(result) => {
                        json!({ "jsonrpc": "2.0", "id": request["id"], "result": result })
                    }
                    None => json!({ "jsonrpc": "2.0", "id": request["id"], "error": {
                        "code": -32601, "message": format!("read-only mock refuses {method}") } }),
                };
                let body = response.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            addr,
            methods,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for MockRpc {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.addr);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn read_request(stream: &mut TcpStream) -> Value {
    let mut bytes = vec![];
    let header_end = loop {
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0, "RPC client disconnected before sending headers");
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .expect("RPC request has Content-Length");
    while bytes.len() < header_end + length {
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0, "RPC client disconnected before sending body");
        bytes.extend_from_slice(&chunk[..count]);
    }
    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
}

fn assert_read_only(methods: &[String]) {
    for method in methods {
        assert!(
            matches!(
                method.as_str(),
                "getGenesisHash"
                    | "getVersion"
                    | "getAccountInfo"
                    | "getMultipleAccounts"
                    | "getBalance"
                    | "getTokenAccountBalance"
            ),
            "unexpected RPC request before preflight finished: {method}; {methods:?}"
        );
    }
}

#[test]
fn repeated_matching_setup_preserves_onchain_addresses_without_transactions() {
    let mut fixture = Fixture::new();
    fixture.funded = true;
    let mut previous = None;
    for _ in 0..2 {
        let (output, methods) = fixture.run("setup");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_read_only(&methods);
        let deployment: Value = serde_json::from_slice(
            &std::fs::read(fixture.dir.path().join("deployments/localnet.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(deployment["cluster"], "localnet");
        assert_eq!(deployment["upgradeAuthority"], fixture.admin.to_string());
        assert_eq!(deployment["attester"], fixture.attester.to_string());
        assert_eq!(deployment["testUsdMint"], fixture.mint.to_string());
        assert_eq!(deployment["pool"], address::pool_vault().to_string());
        for (name, program) in [
            ("bonded_registry", bonded_registry::ID),
            ("bonded_vault", bonded_vault::ID),
            ("bonded_cover", bonded_cover::ID),
        ] {
            assert_eq!(deployment["programs"][name], program.to_string());
        }
        if let Some(previous) = previous {
            assert_eq!(deployment, previous);
        }
        previous = Some(deployment);
    }
}

#[test]
fn pristine_deployment_can_reach_mint_creation() {
    let mut fixture = Fixture::new();
    fixture.funded = true;
    for key in [
        address::registry_config(),
        address::vault_config(),
        address::cover_config(),
        fixture.mint,
        address::pool_vault(),
        address::share_mint(),
    ] {
        fixture.accounts.remove(&key);
    }
    fixture.reaches_initialization("getMinimumBalanceForRentExemption");
}

#[test]
fn empty_pool_without_outstanding_shares_can_reach_initial_seeding() {
    let mut fixture = Fixture::new();
    fixture.funded = true;
    fixture.set_unseeded_pool();
    fixture.reaches_initialization("getLatestBlockhash");
}

#[test]
fn e2e_refuses_an_unseeded_pool_before_minting_or_registering() {
    let mut fixture = Fixture::new();
    fixture.set_unseeded_pool();
    fixture.rejected("e2e", "seeded");
}

#[test]
fn stale_cover_attester_is_rejected_before_funding_or_overwriting_metadata() {
    let mut fixture = Fixture::new();
    fixture.edit_anchor::<bonded_cover::Config>(address::cover_config(), |config| {
        config.attester = Pubkey::new_unique()
    });
    fixture.rejected("setup", "attester");
}

#[test]
fn partial_setup_refuses_registry_attester_mismatch_before_initializing_cover() {
    let mut fixture = Fixture::new();
    fixture.edit_anchor::<bonded_registry::Config>(address::registry_config(), |config| {
        config.attester = Pubkey::new_unique()
    });
    for account in [
        address::cover_config(),
        address::pool_vault(),
        address::share_mint(),
    ] {
        fixture.accounts.remove(&account);
    }
    fixture.rejected("setup", "attester");
}

#[test]
fn e2e_refuses_stale_attester_before_minting_or_registering() {
    let mut fixture = Fixture::new();
    fixture.edit_anchor::<bonded_registry::Config>(address::registry_config(), |config| {
        config.attester = Pubkey::new_unique()
    });
    fixture.rejected("e2e", "attester");
}

#[test]
fn existing_config_admins_must_match_the_local_deployer() {
    for program in [bonded_registry::ID, bonded_vault::ID, bonded_cover::ID] {
        let mut fixture = Fixture::new();
        if program == bonded_registry::ID {
            fixture.edit_anchor::<bonded_registry::Config>(address::registry_config(), |config| {
                config.admin = Pubkey::new_unique()
            });
        } else if program == bonded_vault::ID {
            fixture.edit_anchor::<bonded_vault::Config>(address::vault_config(), |config| {
                config.admin = Pubkey::new_unique()
            });
        } else {
            fixture.edit_anchor::<bonded_cover::Config>(address::cover_config(), |config| {
                config.admin = Pubkey::new_unique()
            });
        }
        fixture.rejected("setup", "admin");
    }
}

#[test]
fn deployed_program_upgrade_authorities_must_match_the_local_deployer() {
    for program in [bonded_registry::ID, bonded_vault::ID, bonded_cover::ID] {
        let mut fixture = Fixture::new();
        fixture.set_upgrade_authority(program, Pubkey::new_unique());
        fixture.rejected("setup", "upgrade");
    }
}

#[test]
fn program_accounts_must_be_executable_and_owned_by_the_upgradeable_loader() {
    for wrong_owner in [false, true] {
        let mut fixture = Fixture::new();
        let program = fixture.accounts.get_mut(&bonded_registry::ID).unwrap();
        if wrong_owner {
            program.owner = Pubkey::new_unique();
        } else {
            program.executable = false;
        }
        fixture.rejected("setup", if wrong_owner { "owner" } else { "executable" });
    }
}

#[test]
fn existing_anchor_and_token_accounts_require_the_correct_program_owners() {
    for token_account in [false, true] {
        let mut fixture = Fixture::new();
        let key = if token_account {
            fixture.mint
        } else {
            address::registry_config()
        };
        fixture.accounts.get_mut(&key).unwrap().owner = Pubkey::new_unique();
        fixture.rejected("setup", "owner");
    }
}

#[test]
fn vault_claims_authority_must_match_the_cover_program() {
    let mut fixture = Fixture::new();
    fixture.edit_anchor::<bonded_vault::Config>(address::vault_config(), |config| {
        config.cover_authority = Pubkey::new_unique()
    });
    fixture.rejected("setup", "authority");
}

#[test]
fn cover_must_use_the_preserved_test_mint() {
    let mut fixture = Fixture::new();
    fixture.edit_anchor::<bonded_cover::Config>(address::cover_config(), |config| {
        config.base_mint = Pubkey::new_unique()
    });
    fixture.rejected("setup", "mint");
}

#[test]
fn existing_test_mint_requires_the_deployer_as_mint_authority() {
    let mut fixture = Fixture::new();
    fixture.edit_mint(fixture.mint, |mint| {
        mint.mint_authority = Some(Pubkey::new_unique()).into()
    });
    fixture.rejected("setup", "mint");
}

#[test]
fn existing_test_mint_requires_six_decimals() {
    let mut fixture = Fixture::new();
    fixture.edit_mint(fixture.mint, |mint| mint.decimals = 9);
    fixture.rejected("setup", "mint");
}

#[test]
fn uninitialized_test_mint_is_rejected() {
    let mut fixture = Fixture::new();
    fixture.edit_mint(fixture.mint, |mint| mint.is_initialized = false);
    fixture.rejected("setup", "initialized");
}

#[test]
fn pool_must_hold_the_configured_base_mint_for_the_cover_program() {
    for wrong_owner in [false, true] {
        let mut fixture = Fixture::new();
        fixture.edit_pool(|pool| {
            if wrong_owner {
                pool.owner = Pubkey::new_unique();
            } else {
                pool.mint = Pubkey::new_unique();
            }
        });
        fixture.rejected("setup", "pool");
    }
}

#[test]
fn initialized_cover_requires_both_pool_accounts() {
    for key in [address::pool_vault(), address::share_mint()] {
        let mut fixture = Fixture::new();
        fixture.accounts.remove(&key);
        fixture.rejected("setup", "missing");
    }
}

#[test]
fn depleted_pool_with_outstanding_shares_is_rejected_before_minting() {
    let mut fixture = Fixture::new();
    fixture.edit_pool(|pool| pool.amount = 0);
    fixture.rejected("setup", "pool");
}
