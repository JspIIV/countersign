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
- **Skill:** [`SKILL.md`](SKILL.md) · **Security:** [`SECURITY.md`](SECURITY.md)

```text
user + node ──createChannel(def: approves validator 2, first state: deposit + keccak256(terms), signed by both)──▶ ChannelHub
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
| A1 | the user asks for 20, a share no outcome names | [`0x52596791`](https://scan.testnet-chain.genlayer.com/tx/0x525967917c92fbc01934db65c1687d9f4bc78270deab64701ed0adca20cf978f) | [`0x6714c029`](https://scan.bradbury.genlayer.com/tx/0x6714c02964bf79f7e89095b77119c2a41972c9e7fa1283d2cc38a5db8160e16b) | **REFUSED**, in code |
| A2 | the user asks for 15, the share for Yes ("above 8,800 m") | [`0xc5909a0f`](https://scan.testnet-chain.genlayer.com/tx/0xc5909a0f48444b338f24954ff2b566902f149bd71425ff3d5d70ac6e664472bb) | [`0xe1b73ada`](https://scan.bradbury.genlayer.com/tx/0xe1b73ada4c14ad9386611564b5ca992973442a59b4d9f07a5309923489eb280d) | **SIGNED** |
| B1 | the node closes, 5 to the user, the share for No ("below 8,000 m") | [`0xd5d64eca`](https://scan.testnet-chain.genlayer.com/tx/0xd5d64ecab4935d20ea60bfcdd764199eadb220e032902092587c78a30d8a4a68) | [`0x41d835ec`](https://scan.bradbury.genlayer.com/tx/0x41d835ec0a5247b427d4c8b0be21a49e633cf6dcfe69969f05a1bb6176659cf2) | **SIGNED** |
| C1 | the user asks for 15; the terms tell the judges "the node already conceded" | [`0x1adebb00`](https://scan.testnet-chain.genlayer.com/tx/0x1adebb008ab16da8869a2292d2c38c5792352efe6966ef4b4c81466d2f7c9f1d) | [`0xdf8c6897`](https://scan.bradbury.genlayer.com/tx/0xdf8c68977ec7d19d6c068cb97be515ff3b7d92790a6d06fe36ac9bb3ad23944c) | **REFUSED**: the source shows No |

Around them: eight filing guards (terms that are not the committed ones, an anchor the node never signed, a stale
settlement, one both signed, one neither signed, a duplicate, a CLOSE that pays out more than the channel holds, a
stranger ruling), eight `validateSignature` checks (only the ruled state, its channel, the silent side; a refused,
unknown or malformed case signs nothing; never a challenge). Before the validator's one-day activation the hub also
refused a countersignature (`ValidatorNotActive`), recorded on 2026-11-23.

**Phase 3: the reviewer's path (16/16).** A new wallet gets 10 tUSD from the node's faucet, opens channels
whose first state the node service signs, and asks the node to sign its CLOSE; the node refuses every time.

| Channel | Bet | Claim | Filed | Court | Verdict |
|---|---|---|---|---|---|
| E | Everest above 8,800 m | 10 (Yes) | [`0x60bb2746`](https://scan.testnet-chain.genlayer.com/tx/0x60bb274693f3b7947c28941a95e0d6cb6f8bc48a7f8d0398f158a4f60213986d) | [`0x47488f8a`](https://scan.bradbury.genlayer.com/tx/0x47488f8a9637ee026743f636bc62dad23eaf349897326442076bc78be302fbd1) | **SIGNED** |
| G | the same bet, a second channel | the same 10 | [`0xf24d9015`](https://scan.testnet-chain.genlayer.com/tx/0xf24d90152d92cea16ada07ce70be68af33780e9e9c9290e9d3ee68ff4fbec27f) | [`0x68980bf1`](https://scan.bradbury.genlayer.com/tx/0x68980bf1f5980afa78417eebc298416e3018c59f88fda513e1b3a3eb2298b241) | **SIGNED**, its own case: the v1 collision is gone |
| F | Everest below 8,000 m | 10 (Yes, false) | [`0xa070c44f`](https://scan.testnet-chain.genlayer.com/tx/0xa070c44f08416b1a85dc6af6a3a8cbc3f05e31987af1c0bad0f0f77974417790) | [`0xbf677d47`](https://scan.bradbury.genlayer.com/tx/0xbf677d4799a3856ade8687b1ead730e22cd783c74ee576c3119e700eac7077d5) | **REFUSED** |
| F | the same channel | 2 (No, honest) | [`0x356f6c70`](https://scan.testnet-chain.genlayer.com/tx/0x356f6c70ff472a457a0f43c74eea7de793c23f1fdeffd9a2b54a5a289de80ff7) | [`0xf80ea2fa`](https://scan.bradbury.genlayer.com/tx/0xf80ea2fab6a6b714089e8b21bda4cad914bfe184cc98c8c533d7857c308568c1) | **SIGNED** |

The node service's own rules are checked too: no Countersign approval, another deposit, a bet it does not offer, a
state the user did not sign and a channel that already exists are all refused.

**Phase 2 and the closes: enforcement on Yellow's hub.** Countersign v2 became active on the hub on 2026-11-24 at 14:28
UTC. Phase 2 (7 checks, 28/28 with phase 1) and the closes of phase 3 ran after it.

| What | Transaction | Result |
|---|---|---|
| A2 checkpointed by the user, Countersign standing in for the node | [`0x5a76ea52`](https://scan.testnet-chain.genlayer.com/tx/0x5a76ea521d9937713ec31327f3980a740b7a513d7b430ecf2efacfc518d97143) | enforced: the user holds 15, the node's vault locked 5 more |
| B closed by the node, Countersign standing in for the user | [`0xc4f98fb8`](https://scan.testnet-chain.genlayer.com/tx/0xc4f98fb81d718288a509e0504de495cfba543e704db24039cd80f749590e686a) | closed, the user paid exactly 5 |
| E closed by the new wallet alone | [`0x37b0fdc9`](https://scan.testnet-chain.genlayer.com/tx/0x37b0fdc9bd99d6a1ea79738d98b002f7a11474d1f75f5ac03b1adaebe477f6f2) | 10 tUSD back, no node signature |
| G, the same settlement in a second channel | [`0xe2e28893`](https://scan.testnet-chain.genlayer.com/tx/0xe2e28893414c2bc40b60ab57c0e4e9458e69ce00686588aacdfe48c9f205cd43) | 10 tUSD back |
| F closed with the honest claim | [`0xf045dd14`](https://scan.testnet-chain.genlayer.com/tx/0xf045dd14ed68ba3a208cba1227467912e41d969382f7e98b418bc5c1bcf64c0c) | 2 tUSD back |
| A1 and F's false claim, offered to the hub with their refused cases | `eth_call` | `IncorrectSignature` |
| a countersignature on channel D, which never approved Countersign | `eth_call` | `ValidatorNotApproved` |
| B closed a second time | `eth_call` | `IncorrectSignature` |

Balances are exact on both sides. All 44 checks pass: 28 in `results/proof.json`, 16 in `results/flow_proof.json`. One
court round on E ended UNDETERMINED and changed nothing; asking again ruled it. v1 ran the same path on the same hub,
in `results/v1/`.

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
