# Community attack bounties

Anyone can submit an attack the library misses and be paid from the bounty pool. The pool is the `BountyBoard` contract, funded by 5% of every premium (`CoverManager.bountyFeeBps`). The flow is in docs/PLAN.md Section 13.1 and ADR-004; this page covers how it works off chain.

## Flow

1. **Write the attack** in the library's YAML format (`attacks/<class>/*.yaml`, schema `AttackSpec` in `@bonded/shared`).
2. **Commit** on `BountyBoard`: `commit(keccak256(abi.encode(hunter, specURI, salt)))`. Here `specURI` is `sha256:<hex>`, the hash of the exact YAML text. The commitment timestamps the attack without revealing it, and the hunter's address is part of it, so nobody else can reveal a copied commitment.
3. **Reveal** on `BountyBoard`: `reveal(id, specURI, salt)`, from the hunter's address.
4. **Send the YAML** to `POST /bounties/:id/reveal`. No operator token is needed. The API takes the spec only if the submission is revealed on chain and the body's sha256 matches the revealed `specURI`. Posting the same submission again just returns its status.
5. **Validation:** the Arena worker runs the attack in a sandbox against the reference agents. The attester then sends `accept(id, reward)` or `reject(id, keccak256(reason))`.
6. **An accepted attack joins the library** for that chain, and every enabled agent is queued for a fresh rating. Premiums reprice against it, like an antivirus signature update.

The web app's Bounties page does steps 2–4 with a connected wallet. It shows the pool balance and every submission's status.

## The decision (deterministic)

The reference agents are the scripted vulnerable agent (undefended) and the scripted hardened agent (defended). Both are deterministic, so a payout never depends on a model. The rule is in `apps/arena/src/bounty.ts`. Each agent gets 3 runs.

| Outcome | Rule |
|---|---|
| Reject: duplicate | Same id as a library seed, or at least 80% word overlap with a seed of the same class (numbers, addresses and placeholders ignored) |
| Reject: not reproducible | Breaches the undefended agent in fewer than 2 of 3 runs |
| **Accept, 2,000 tUSDG** | Breaches the defended agent in at least 2 of 3 runs: it beats current defences |
| **Accept, 500 tUSDG** | Reproducible, and opens a class and surface the library doesn't cover |
| Reject: known | Anything else: a known class and surface that beats no defence |

Assumptions and limits:
- **The scripted agents read only phrasings their parser knows.** An attack worded so the undefended script doesn't recognise it is rejected as not reproducible, even if an LLM agent would obey it. Adding an LLM reference agent would widen this, at the cost of non-deterministic payouts.
- **The pool must hold the reward.** `accept` reverts with `InsufficientFunds` otherwise, and the job retries three times and is then marked `failed`.
- **The validation, its transaction and any retry are idempotent.** A retry recovers an `accept` or `reject` already sent from the board's events instead of sending it again.
- **Bounty validation and ratings share one attester key.** They take the same per-chain lock, so their transactions never race for a nonce.

## Privacy

`GET /bounties` and the page show the title, class, surfaces, status, reward and reason, never the payload. An accepted attack runs in every later rating, but its text isn't published. The disclosure policy (docs/disclosures) applies to bounty attacks as it does to leaderboard findings.
