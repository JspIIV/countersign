---
name: countersign-nitrolite-validator
description: Put a Yellow Nitrolite state channel under Internet Court. Approve the Countersign signature validator in the channel definition and commit the session's terms (question, https source, user share per answer) in the first state; if a party later refuses to sign the settlement those terms require, anybody files it, a GenLayer court reads the source, and the court's countersignature stands in for the silent party on Yellow's ChannelHub. Use when a Yellow app session needs a way to settle without the other side's cooperation.
---

# Countersign: Internet Court as a Nitrolite signature validator

## Deployed

| Contract | Address | Where |
|---|---|---|
| The court (Intelligent Contract) | `0xdB347ea00FBF35b21b5a8dE271CaA3b13FA00B2B` | GenLayer Bradbury |
| Countersign (validator id 3) | `0xA372004bA02A12B25250cbaCDb9751eAfeC4167C` | GenLayer Chain (4221) |
| ChannelHub (Yellow's Nitrolite, unmodified) | `0x6999925Cc2F8a17A0D28c43840eE03044412EE87` | GenLayer Chain |
| Test USD | `0x7D680257bD85CD110bAc03fdD4Da657ba88bf10a` | GenLayer Chain |

RPC for GenLayer writes: `https://rpc.bradbury.genlayer.com` (genlayer-js 2.1.0; reads only, sends go to the chain RPC). RPC for EVM calls: `https://rpc.testnet-chain.genlayer.com`.
Shared encoders: [`lib/channel.mjs`](lib/channel.mjs).

## Workflow

1. **Open the channel with Countersign approved and the terms committed.**
   ```js
   const def = { challengeDuration: 86400, user, node, nonce, approvedSignatureValidators: 1n << 3n, metadata: ZeroHash };
   const first = { version: 1n, intent: DEPOSIT, metadata: keccak256(toUtf8Bytes(termsJson)), homeLedger: deposit };
   // both sign: [0x00][EIP-191 over abi.encode(channelId, signingData(first))]
   await hub.createChannel(def, { ...first, userSig, nodeSig });
   ```
   Terms: `{"agreement", "question", "sources": ["https://..."], "outcomes": [{"answer", "user_share"}, ...]}`, two to
   eight outcomes, user shares in token units of the channel's funds.
2. **When the session ends and the other side will not sign,** sign your settlement (OPERATE, or CLOSE on top of the
   first state) and file it:
   ```js
   const caseId = await countersign.fileCase(channelId, firstState, mySignedSettlement, termsJson);
   ```
3. **Anybody asks the court,** funding the message that delivers the verdict:
   ```js
   const gasLimit = 300000n, maxGasPrice = 1000000000n, budget = gasLimit * maxGasPrice;
   const messageAllocations = [{ messageType: 0, onAcceptance: false, recipient: COUNTERSIGN, budget,
     feeParams: AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [gasLimit, maxGasPrice]) }];
   const q = await client.estimateTransactionFees({ totalMessageFees: budget, messageAllocations });
   await client.writeContract({ address: COURT, functionName: 'rule', args: [caseId],
     fees: { distribution: q.distribution, feeValue: q.feeValue, messageAllocations } });
   ```
4. **Once `getCase(caseId).verdict` is SIGNED (2),** enforce on the hub with the case as the missing signature:
   ```js
   const countersig = concat(['0x03', zeroPadValue(toBeHex(caseId), 32)]);   // validator id 3, then the case id
   await hub.closeChannel(channelId, { ...mySignedSettlement, nodeSig: countersig });   // or checkpointChannel for OPERATE
   ```

## Decision payload

| Field | Where | Meaning |
|---|---|---|
| `verdict` | `Countersign.getCase(id)` | 1 FILED, 2 SIGNED, 3 REFUSED |
| `proposedUserShare`, `total` | same | what the settlement gives the user, out of the channel's funds |
| `verdict`, `answer_text`, `why`, `judges` | court `case(id)` | the answer found and the reasoning kept |
| `reason` | `Countersign.getCase(id)` | the court's commitment to the ruling |

## Limits

- The question must be settled by a cited https source; otherwise REFUSED and the channel stays where it was.
- Countersign must be registered by the hub's node (active a day later) and approved in the channel's definition.
- The court and Countersign reach each other directly on GenLayer Chain; Yellow hubs elsewhere need a relay.
