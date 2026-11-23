# Security

What each party can and cannot do, where the code enforces it, and which check proves it on chain. Line numbers are in
[`evm/Countersign.sol`](evm/Countersign.sol); checks are in `scripts/prove.mjs` (P) and `scripts/prove_flow.mjs` (F).

## What Countersign can sign

| Guarantee | Enforced | Proven |
|---|---|---|
| Only a case the court SIGNED counts as a signature | `validateSignature`, line 218 (`c.verdict != SIGNED`) | P: a refused case signs nothing; F: the hub rejects a close with a refused case |
| Only for the ruled state's exact signing data | line 218 (`c.stateHash != keccak256(signingData)`) | P: not for another state of the same channel |
| Only in the channel it was filed for | line 218 (`c.channelId != channelId`) | P: not in another channel |
| Only as the silent side's signature | line 218 (`c.respondent != participant`) | P: not for the user who proposed it |
| A countersigned CLOSE only on top of the judged anchor | line 218 (`last.version != c.anchorVersion`) | the payout is exactly what was judged |
| Never a challenge | `validateChallengeSignature`, line 239, always fails | P: the court never signs a challenge |
| Unknown or malformed case ids sign nothing | line 218 (length and range checks) | P: two checks |

## What can be filed

| Guarantee | Enforced | Proven |
|---|---|---|
| Only an open channel on the hub | line 138, `ChannelNotOpen` | |
| Only the terms the first state commits to | line 140, `TermsMismatch` | P |
| Only a first state both parties signed, against the hub's own definition | line 144, `AnchorNotSigned` | P |
| Only a newer OPERATE or CLOSE on the same terms and token | line 152, `IncorrectSettlement` | P |
| Only a settlement one side signed and the other did not | lines 156-157 | P: both signed needs no court; neither signed is refused |
| A CLOSE pays out exactly the channel's funds | line 168, `SharesDoNotAddUp` | P |
| One case per settlement per channel and respondent | line 175, key `keccak256(channelId, stateHash, respondent)` | P: the same settlement twice; F: the same settlement in a second channel is its own case |

## Who rules

| Guarantee | Enforced | Proven |
|---|---|---|
| Only the court's address, set once by the deployer | `setCourt`, lines 117-119; `rule`, line 205 | P: nobody but the court can rule; the page's "Try to break it" |
| A ruled case is final | line 208, `AlreadyRuled` | |
| The court's verdict lands only when final | the court calls Countersign through its Ghost as a message sent at finality (`onAcceptance: false`) | every case in the proof |
| The model only answers which answer the source shows; shares are compared in code | `contracts/countersign.py`: `_judge` asks for the answer only, `rule` compares the shares from Countersign's own facts | P: A1 refused in code; 46 unit checks |
| Terms that instruct the judges are evidence of nothing | the court's task frames terms and pages as untrusted | P: C1 "the node conceded" refused |

## Fixed in v2

Countersign v1 keyed filings on `keccak256(stateHash, respondent)`. Nitrolite's signing data does not name the channel,
so two channels on the same terms produce identical settlements: one could be filed first to block the other forever
(`AlreadyFiled`). Found by testing the live page with a second channel; v2 adds `channelId` to the key (line 175). The
v1 contracts are listed in `deployment.json` under `previous`.

## The demo node service

[`api/node.mjs`](api/node.mjs) holds a testnet key. It signs a first state only when the channel names this node,
approves Countersign and nothing else, has a one-day challenge period, deposits exactly 10 tUSD of the user's, commits to
one of the listed bets, does not exist yet, and carries the user's own signature (F: five checks). It never signs a
settlement. Its faucet sends 10 tUSD only to a wallet holding fewer than 10.

## What remains trusted

- **The source.** The court rules on what the cited page shows. Parties choose their sources when they sign the terms.
- **GenLayer's validators**, for which answer the source shows: a majority must agree, and a verdict acts only at
  finality, so it can be appealed first.
- **The node's registration of Countersign** on the hub: without it no channel can approve Countersign. Yellow's hub
  makes a registration wait a day before it is active.
