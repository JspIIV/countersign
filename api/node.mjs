// The demo Nitrolite node, as a Vercel function. It holds one key (NODE_KEY, a testnet key) and does three things:
//
//   POST /api/node?op=faucet  { user }                 sends 10 test dollars to a wallet that has fewer than 10
//   POST /api/node?op=open    { def, anchor, bet }     countersigns the first state of a new channel, under strict rules
//   POST /api/node?op=settle  { channelId, state }     refuses: this node goes silent once the money is in
//   GET  /api/node?op=info                             its address, the contracts, the bets it opens channels on
//
// Going silent after the deposit is the failure Countersign exists for: a Yellow node that will not sign the settlement
// it owes. The page then files the case, Internet Court rules, and the court's countersignature stands in for the node.
import { Wallet, JsonRpcProvider, Contract, verifyMessage, getAddress } from 'ethers';
import A from '../lib/addresses.mjs';
import { BETS, CHAIN_ID, CHALLENGE, DEPOSIT, INTENT, anchor as anchorOf, channelId, signedMessage, withValidatorByte, unpackState, unpackDef, pack, termsHash } from '../lib/channel.mjs';

const RPC = 'https://rpc.testnet-chain.genlayer.com';
const HUB_ABI = ['function getChannelData(bytes32) view returns (uint8 status, tuple(uint32 challengeDuration,address user,address node,uint64 nonce,uint256 approvedSignatureValidators,bytes32 metadata) def, tuple(uint64 version,uint8 intent,bytes32 metadata,tuple(uint64 chainId,address token,uint8 decimals,uint256 userAllocation,int256 userNetFlow,uint256 nodeAllocation,int256 nodeNetFlow) homeLedger,tuple(uint64 chainId,address token,uint8 decimals,uint256 userAllocation,int256 userNetFlow,uint256 nodeAllocation,int256 nodeNetFlow) nonHomeLedger,bytes userSig,bytes nodeSig) lastState, uint256 challengeExpiry, uint256 lockedFunds)'];
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const node = process.env.NODE_KEY ? new Wallet(process.env.NODE_KEY, provider) : null;
const hub = new Contract(A.channel_hub, HUB_ABI, provider);
const token = new Contract(A.token, ERC20, provider);
const VID = A.validator_id;

class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The node's rules for a first state. Everything a reviewer can open is one of the listed bets, 10 tUSD, Countersign approved. */
export async function checkOpen({ def: rawDef, anchor: rawAnchor, bet }, nodeAddress = node?.address) {
  if (!BETS[bet]) refuse('unknown bet');
  const def = unpackDef(rawDef), a = unpackState(rawAnchor);
  if (!eq(def.node, nodeAddress)) refuse('the channel must name this node');
  if (def.challengeDuration !== CHALLENGE) refuse('the challenge period must be one day');
  if (def.approvedSignatureValidators !== (1n << BigInt(VID))) refuse('the channel must approve Countersign, and only Countersign');
  if (def.metadata !== '0x' + '00'.repeat(32)) refuse('no definition metadata');
  const want = anchorOf(A.token, bet);
  const L = a.homeLedger, W = want.homeLedger;
  if (a.version !== 1n || a.intent !== INTENT.DEPOSIT || a.metadata !== want.metadata) refuse('the first state must be a deposit committing to the bet');
  if (L.chainId !== W.chainId || !eq(L.token, W.token) || L.decimals !== 6 || L.userAllocation !== DEPOSIT || L.userNetFlow !== DEPOSIT || L.nodeAllocation !== 0n || L.nodeNetFlow !== 0n)
    refuse('the first state must hold exactly the user\'s 10 tUSD');
  const cid = channelId(def);
  let signer = null;
  try { signer = verifyMessage(signedMessage(cid, a), '0x' + String(a.userSig || '').slice(4)); } catch { signer = null; }
  if (!String(a.userSig || '').startsWith('0x00') || !signer || !eq(signer, def.user)) refuse('the user has not signed this state');
  const [status] = await hub.getChannelData(cid);
  if (Number(status) !== 0) refuse('this channel already exists');
  return { def, anchor: a, cid };
}

async function handle(op, body) {
  if (op === 'info') return { node: node?.address || null, validator_id: VID, hub: A.channel_hub, countersign: A.countersign,
    court: A.court, token: A.token, bets: BETS, deposit: '10', chain_id: CHAIN_ID };
  if (!node) refuse('the node has no key configured');
  if (op === 'faucet') {
    const user = getAddress(body.user);
    if ((await token.balanceOf(user)) >= DEPOSIT) refuse('this wallet already holds 10 tUSD or more');
    const tx = await token.connect(node).transfer(user, DEPOSIT);
    await tx.wait();
    return { sent: '10', tx: tx.hash };
  }
  if (op === 'open') {
    const { anchor: a, cid } = await checkOpen(body);
    const nodeSig = withValidatorByte(await node.signMessage(signedMessage(cid, a)));
    return { channelId: cid, nodeSig, terms: BETS[body.bet].terms, termsHash: termsHash(BETS[body.bet].terms) };
  }
  if (op === 'settle') refuse('This node signs channel openings and then goes silent. It will not sign your settlement: take it to Internet Court.');
  refuse('unknown op');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const op = String(req.query?.op || new URL(req.url, 'http://x').searchParams.get('op') || 'info');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  try {
    res.status(200).json(pack(await handle(op, body || {})));
  } catch (e) {
    res.status(e instanceof Refusal ? 400 : 500).json({ error: e instanceof Refusal ? e.message : String(e.shortMessage || e.message).slice(0, 200) });
  }
}
