# Countersign

**Internet Court as a Yellow Nitrolite signature validator. When one side of a state channel refuses to sign the
settlement both agreed terms require, a GenLayer court reads the cited source, and its countersignature stands in for
the silent side on Yellow's own ChannelHub.**

Internet Court · GenLayer · Yellow (Nitrolite).

A Nitrolite state channel moves money only on states both sides signed. When an app session ends and one side refuses
to sign the settlement it owes, the other has no recourse: the protocol falls back to the last state both signed, and
the money sits there. Internet Court's own skill repository says it of Yellow: the session "has no dispute mechanism,
challenge, or timeout of its own".

Nitrolite has a hook for exactly this: a channel can approve extra **signature validators**, contracts the hub asks
whether a signature is valid. Countersign is one. A channel that approves it accepts, in place of a party's signature,
the id of a case Internet Court decided, and only for the exact state the court found the parties' terms to require.

- **Live demo:** https://jspiiv.github.io/countersign/: open a channel with a node that goes silent, take your claim
  to the court, close the channel without the node; or claim falsely and watch the court and the hub refuse.
- **The court (GenLayer Bradbury):** [`0xdB347ea00FBF35b21b5a8dE271CaA3b13FA00B2B`](https://scan.bradbury.genlayer.com/address/0xdB347ea00FBF35b21b5a8dE271CaA3b13FA00B2B)
- **Countersign (GenLayer Chain):** `0xA372004bA02A12B25250cbaCDb9751eAfeC4167C`, validator id 3 on the hub
- **Moved to Bradbury Phase 3 on 2026-11-26.** GenLayer moved its testnet to Phase 3 on 2026-11-25, and a court on
  Phase 2 can no longer give new rulings. The court and Countersign were deployed again with the same code (only the
  court's runner line changed), registered on the same hub as validator id 3, and proven again after its one-day
  activation. The Phase 2 addresses are kept in `deployment.json` (`previous`), their proof in `results/v2/`.
- **Skill:** [`SKILL.md`](SKILL.md) · **Security:** [`SECURITY.md`](SECURITY.md)

```text
user + node ──createChannel(def: approves validator 3, first state: deposit + keccak256(terms), signed by both)──▶ ChannelHub
session ends; the user signs its settlement; the node goes silent
anybody ──fileCase(channel, first state, signed settlement, terms)──▶ Countersign: checks both against the hub, files a case
anybody ──rule(case)──▶ the court (GenLayer): validators read the cited source, agree on the answer; shares compared in code
the court's Ghost ──rule(case, SIGNED | REFUSED)──▶ Countersign          (when the verdict is final; no relayer, no key)
user ──closeChannel(state, nodeSig = [0x03][caseId])──▶ ChannelHub ──validateSignature──▶ Countersign ──▶ paid
```

## The parts

| Contract | Where | What |
|---|---|---|
| `ChannelHub`, `ChannelEngine`, `EscrowDepositEngine`, `EscrowWithdrawalEngine`, `ECDSAValidator`, `PremintERC20` | GenLayer Chain (4221) | Yellow's [Nitrolite](https://github.com/layer-3/nitrolite) at `b88d511c`, the commit Yellow deployed as sandbox v1.3.0, **unmodified** in `vendor/nitrolite`, built with its own settings |
| [`Countersign`](evm/Countersign.sol) | GenLayer Chain | the signature validator: files cases against the hub's own record, takes verdicts from the court alone, and answers `validateSignature` |
| [`countersign.py`](contracts/countersign.py) | GenLayer Bradbury | the court: an Intelligent Contract that reads the terms and their cited source and rules SIGNED or REFUSED |
| [`api/node.mjs`](api/node.mjs) | Vercel | the demo node: signs channel openings under strict rules, hands out test dollars, and then refuses every settlement |

`node scripts/verify_evm.mjs` rebuilds Yellow's contracts and compares them with the chain: our ChannelHub matches
**Yellow's live Base Sepolia hub** (`0x5dba8515...`) in all 23,945 executable bytes, and every contract on GenLayer
Chain matches its source.

## The terms

Both parties commit to the terms in the first state they sign: its `metadata` is `keccak256` of this JSON.

```json
{"agreement": "...", "question": "Is the height of Mount Everest given by the source above 8,800 metres?",
 "sources": ["https://en.wikipedia.org/api/rest_v1/page/summary/Mount_Everest"],
 "outcomes": [{"answer": "Yes", "user_share": "10"}, {"answer": "No", "user_share": "2"}]}
```

The court asks GenLayer validators one thing only: which answer do the cited sources show. Everything else is code: a
settlement whose user share no outcome names is REFUSED without a model; a settlement whose share differs from the one
named for the answer found is REFUSED; terms that do not hash to the committed metadata are refused at filing.

## Why it holds

- **Only the committed terms count.** Filing checks `keccak256(terms)` against the first state's metadata, and that
  state must carry both parties' signatures, checked against the hub's own channel definition.
- **Only the exact state, in that channel, for the silent side.** A countersignature is valid only for the ruled
  state's signing data, only in its channel, and only as the respondent's signature; a refused case, an unknown case or
  a malformed one signs nothing; the court never signs a challenge.
- **A CLOSE only on top of the judged anchor.** A countersigned CLOSE is valid only while the channel's last enforced
  state is still the one the case was filed against, so the payout is exactly the one judged.
- **Only the court rules, once.** Countersign takes verdicts from the court's address alone, set once; a ruled case is
  final.
- **Neither side can talk the judges round.** Terms that tell the judges which answer to pick ("the node already
  conceded") are refused by what the source shows; proven on chain.
- **Each channel's settlement is its own case.** See below.
- **The node signs openings only.** The demo node service signs a first state only for a listed bet, a 10 tUSD deposit
  and a channel that approves Countersign alone, and only if the user signed it.

## Found by our own page, fixed in v2

Testing the live page with a second channel on the same bet, filing the same claim failed with `AlreadyFiled`.
Countersign v1 (validator id 1, `0x292352BC...`) keyed filings on `keccak256(stateHash, respondent)`, and Nitrolite's
signing data does not name the channel: two channels on the same terms produce byte-identical settlements. Beyond a
demo that stops working after a few visitors, that is a griefing attack: open your own channel on the same terms, file a
copy of somebody's future settlement, and theirs can never be filed. v2 keys filings on
`keccak256(channelId, stateHash, respondent)`, and the proof files the same settlement in two channels. v1 and its
proof are kept in `deployment.json` (`previous`) and `results/v1/`.

## Proven

`scripts/prove.mjs` (phases 1 and 2) and `scripts/prove_flow.mjs` (phase 3), against the contracts above, with every
transaction in `results/`. In phase 1, padv is the user, ppub the node and pchg a stranger who files the cases and asks
the court. Phase 3 is the page's path, run with a brand-new wallet and the real node service code.

**Phase 1: cases and verdicts (21 checks).** Four channels open on Yellow's hub with 10 tUSD each, three approving
Countersign. Terms: Mount Everest's height from Wikipedia, Yes 15 / No 5.

| Case | Settlement | Filed | Court | Verdict |
|---|---|---|---|---|
| A1 | the user asks for 20, a share no outcome names | [`0x4f00fbdb`](https://scan.testnet-chain.genlayer.com/tx/0x4f00fbdbef93d3e8e5d8a0051368eed7a1128c2f77dac16283f0d1b46dcbbc52) | [`0x74304067`](https://scan.bradbury.genlayer.com/tx/0x74304067cf2158a0a03aceca5e125059fac5f8aab3e0a57ec27f4c742d26e6f0) | **REFUSED**, in code |
| A2 | the user asks for 15, the share for Yes ("above 8,800 m") | [`0x4ea4632c`](https://scan.testnet-chain.genlayer.com/tx/0x4ea4632ce35639df07fbd66da352d8eccdf1f2f184af2d48a700c4af9a67cae1) | [`0x4fa3499a`](https://scan.bradbury.genlayer.com/tx/0x4fa3499ab61e22bf4ed49faae6ef543591ea05e56bf813a54ad844da8690e0df) | **SIGNED** |
| B1 | the node closes, 5 to the user, the share for No ("below 8,000 m") | [`0x5e816ead`](https://scan.testnet-chain.genlayer.com/tx/0x5e816eadf0ccd205453fdf1792cbbb47c8f438480d2a85438d613cb0710f17a9) | [`0x32fa3ef2`](https://scan.bradbury.genlayer.com/tx/0x32fa3ef2e4164a56cc5a6e2d856d33a4785a30befde6a37e776b3e9da97a758d) | **SIGNED** |
| C1 | the user asks for 15; the terms tell the judges "the node already conceded" | [`0x210346ee`](https://scan.testnet-chain.genlayer.com/tx/0x210346ee8b081b711709ecc3d1134e806c2e6b84b8b446de467d2bb66fed7d2a) | [`0x44dc9fd9`](https://scan.bradbury.genlayer.com/tx/0x44dc9fd9c2b6a2c64b4d912dc23e00b0ab5471871dce7c7809d4e30d66e58424) | **REFUSED**: the source shows No |

Around them: eight filing guards (terms that are not the committed ones, an anchor the node never signed, a stale
settlement, one both signed, one neither signed, a duplicate, a CLOSE that pays out more than the channel holds, a
stranger ruling), eight `validateSignature` checks (only the ruled state, its channel, the silent side; a refused,
unknown or malformed case signs nothing; never a challenge). Before the validator's one-day activation the hub also
refused a countersignature (`ValidatorNotActive`), recorded on 2026-11-26.

**Phase 3: the reviewer's path (16/16).** A new wallet gets 10 tUSD from the node's faucet, opens channels
whose first state the node service signs, and asks the node to sign its CLOSE; the node refuses every time.

| Channel | Bet | Claim | Filed | Court | Verdict |
|---|---|---|---|---|---|
| E | Everest above 8,800 m | 10 (Yes) | [`0xf670bbe1`](https://scan.testnet-chain.genlayer.com/tx/0xf670bbe18ba39109b03ed275885f72ed6f9a0ffbd4c968a407655df396b3d5ec) | [`0x599938b2`](https://scan.bradbury.genlayer.com/tx/0x599938b27047d49eeff91cbc660890615135e43a3202ba040af6bbf298a5e488) | **SIGNED** |
| G | the same bet, a second channel | the same 10 | [`0xcac916f7`](https://scan.testnet-chain.genlayer.com/tx/0xcac916f721fce5bb9e9c8e6294e359aff338309722d7371f5da59642d52c9775) | [`0xf455b21f`](https://scan.bradbury.genlayer.com/tx/0xf455b21fcf0205d7845e4343ecc032303151107e87f94f39b3676d43900ad048) | **SIGNED**, its own case: the v1 collision is gone |
| F | Everest below 8,000 m | 10 (Yes, false) | [`0x38d4a8f2`](https://scan.testnet-chain.genlayer.com/tx/0x38d4a8f28b1d20eaf3d51dd48ace8db17c42c3db544719417f6130a9a8aa6e50) | [`0x66b82843`](https://scan.bradbury.genlayer.com/tx/0x66b828439ba109db73bc25d9e677578762b1ace00a004cce93344346bd0f1157) | **REFUSED** |
| F | the same channel | 2 (No, honest) | [`0x4394c816`](https://scan.testnet-chain.genlayer.com/tx/0x4394c816d3653ce72d8f6d29fd67abf338fbe9aa26bc3e2411c4f5d7cf241c91) | [`0x5349e389`](https://scan.bradbury.genlayer.com/tx/0x5349e389157f40739ae13f14d605710babfd122b62afffd84173c0e5cb5485f4) | **SIGNED** |

The node service's own rules are checked too: no Countersign approval, another deposit, a bet it does not offer, a
state the user did not sign and a channel that already exists are all refused.

**Phase 2 and the closes: enforcement on Yellow's hub.** Countersign became active on the hub on 2026-11-26 at 19:02
UTC. Phase 2 (7 checks, 28/28 with phase 1) and the closes of phase 3 ran after it.

| What | Transaction | Result |
|---|---|---|
| A2 checkpointed by the user, Countersign standing in for the node | [`0xa72ba096`](https://scan.testnet-chain.genlayer.com/tx/0xa72ba096cb21ee2357e11c4ad83c9335d42a3819d0baa2b36fa1bd2d35c7b8dd) | enforced: the user holds 15, the node's vault locked 5 more |
| B closed by the node, Countersign standing in for the user | [`0x34fa5162`](https://scan.testnet-chain.genlayer.com/tx/0x34fa516273303e4bb5a34f7062c58f7eff2d233714f52bfb35c1e35f5d49debe) | closed, the user paid exactly 5 |
| E closed by the new wallet alone | [`0xd3e0872b`](https://scan.testnet-chain.genlayer.com/tx/0xd3e0872b40103e190db4c1b87c9c6d8d0167b56ece9e9cf02bbb4714929ddbda) | 10 tUSD back, no node signature |
| G, the same settlement in a second channel | [`0x8bd5edc7`](https://scan.testnet-chain.genlayer.com/tx/0x8bd5edc700ca68510e1d0fa37e971144cd6855dde660660de63bb5de997b9285) | 10 tUSD back |
| F closed with the honest claim | [`0x3d129dd9`](https://scan.testnet-chain.genlayer.com/tx/0x3d129dd918dba1db0c1fe13231730978668767e0938ad4b8bb5666277dd595b7) | 2 tUSD back |
| A1 and F's false claim, offered to the hub with their refused cases | `eth_call` | `IncorrectSignature` |
| a countersignature on channel D, which never approved Countersign | `eth_call` | `ValidatorNotApproved` |
| B closed a second time | `eth_call` | `IncorrectSignature` |

Balances are exact on both sides. All 44 checks pass: 28 in `results/proof.json`, 16 in `results/flow_proof.json`. The
same proof on Bradbury Phase 2 (validator id 2) is in `results/v2/`, and v1 ran the same path on the same hub, in
`results/v1/`.

## Tests

`python tests/countersign_rules.py`: 46 checks through the real court against a stub of the runtime and of
Countersign: terms parsing and every refusal, SIGNED and REFUSED and what each sends, shares compared in code,
hostile terms in both directions, rounds that do not settle.

## Run it yourself

```bash
npm install
git submodule update --init --recursive     # Yellow's Nitrolite and OpenZeppelin at the pinned commits
python tests/countersign_rules.py
node scripts/verify_evm.mjs                  # Yellow's contracts against the chain, Countersign against its source
NODE_KEY=0x... node server/local.mjs         # the page and the node service on http://localhost:8410
```

## Where it stops, plainly

- The court answers questions a cited https source settles. Terms that cite no source, or a source that does not settle
  the question, are REFUSED: the channel then stays where both signatures left it.
- The hub here is Yellow's code on GenLayer Chain, where the court reaches Countersign directly. On Yellow's own hubs on
  other chains, the verdict would need a relay to reach a Countersign deployed there.
- Validator registration is the node's: a channel can approve Countersign only if the node registered it on the hub,
  and a registration takes a day to become active.
- The demo node is a script with one key on Vercel. A real Yellow clearnode would register Countersign once and keep
  signing as usual; the court only matters when it stops.

## Licence

MIT. Nitrolite stays in `vendor/nitrolite` under its own licence, as a pinned submodule, unmodified.
