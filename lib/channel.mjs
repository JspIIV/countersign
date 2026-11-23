// What the page, the node service and the scripts share: the bets a channel can be opened on, the channel definition,
// the first state both sign, and a settlement. Nitrolite's own encoding lives in scripts/states.mjs.
import { AbiCoder, keccak256, toUtf8Bytes, getBytes, concat, toBeHex, zeroPadValue, parseUnits } from 'ethers';

export const CHAIN_ID = 4221;
export const HUB_VERSION = 1;
export const INTENT = { OPERATE: 0, CLOSE: 1, DEPOSIT: 2, WITHDRAW: 3 };
export const DEPOSIT = parseUnits('10', 6);
export const CHALLENGE = 86400;
const coder = AbiCoder.defaultAbiCoder();
const LEDGER = 'tuple(uint64 chainId, address token, uint8 decimals, uint256 userAllocation, int256 userNetFlow, uint256 nodeAllocation, int256 nodeNetFlow)';
export const EMPTY_LEDGER = { chainId: 0n, token: '0x0000000000000000000000000000000000000000', decimals: 0, userAllocation: 0n, userNetFlow: 0n, nodeAllocation: 0n, nodeNetFlow: 0n };

const SOURCE = 'https://en.wikipedia.org/api/rest_v1/page/summary/Mount_Everest';
const AGREEMENT = 'A bet inside a Yellow app session. The user put 10 tUSD in the channel; the session ends with the share below for the answer the source shows.';
const terms = (question, yes, no) => JSON.stringify({ agreement: AGREEMENT, question, sources: [SOURCE],
  outcomes: [{ answer: 'Yes', user_share: String(yes) }, { answer: 'No', user_share: String(no) }] });

/** The bets the demo node opens channels on. Each is plain JSON the court reads; the channel commits to its hash. */
export const BETS = {
  above8800: { title: 'Everest is above 8,800 m', terms: terms('Is the height of Mount Everest given by the source above 8,800 metres?', 10, 2), yes: '10', no: '2' },
  below8000: { title: 'Everest is below 8,000 m', terms: terms('Is the height of Mount Everest given by the source below 8,000 metres?', 10, 2), yes: '10', no: '2' },
};
export const termsHash = (t) => keccak256(toUtf8Bytes(t));
export const betOf = (hash) => Object.entries(BETS).find(([, b]) => termsHash(b.terms) === hash)?.[0] || null;

/** A ChannelDefinition as the hub hashes it, and its id. */
export const definition = ({ user, node, nonce, validatorId }) => ({ challengeDuration: CHALLENGE, user, node, nonce: BigInt(nonce),
  approvedSignatureValidators: 1n << BigInt(validatorId), metadata: '0x' + '00'.repeat(32) });
export function channelId(def) {
  const base = keccak256(coder.encode(['uint32', 'address', 'address', 'uint64', 'uint256', 'bytes32'],
    [def.challengeDuration, def.user, def.node, def.nonce, def.approvedSignatureValidators, def.metadata]));
  return '0x' + toBeHex(HUB_VERSION, 1).slice(2) + base.slice(4);
}
const ledger = (token, userAllocation, userNetFlow, nodeAllocation = 0n, nodeNetFlow = 0n) =>
  ({ chainId: BigInt(CHAIN_ID), token, decimals: 6, userAllocation, userNetFlow, nodeAllocation, nodeNetFlow });

/** The first state: the user's 10 tUSD in, the terms' hash as metadata. Both sign it; the user opens the channel with it. */
export const anchor = (token, bet) => ({ version: 1n, intent: INTENT.DEPOSIT, metadata: termsHash(BETS[bet].terms), homeLedger: ledger(token, DEPOSIT, DEPOSIT) });

/** The user's CLOSE paying `share` tUSD to the user and the rest of the 10 to the node, on top of the anchor. */
export function closeFor(token, bet, share) {
  const toUser = parseUnits(String(share), 6);
  if (toUser < 0n || toUser > DEPOSIT) throw new Error('a share between 0 and 10');
  return { version: 2n, intent: INTENT.CLOSE, metadata: termsHash(BETS[bet].terms), homeLedger: ledger(token, 0n, DEPOSIT - toUser, 0n, -(DEPOSIT - toUser)) };
}

export const signingData = (s) => coder.encode(['uint64', 'uint8', 'bytes32', LEDGER, LEDGER], [s.version, s.intent, s.metadata, s.homeLedger, s.nonHomeLedger || EMPTY_LEDGER]);
/** What a party signs (EIP-191): abi.encode(channelId, signingData), the hub's default ECDSA validator. */
export const signedMessage = (cid, s) => getBytes(coder.encode(['bytes32', 'bytes'], [cid, signingData(s)]));
export const withValidatorByte = (sig) => concat(['0x00', sig]);
export const countersigned = (validatorId, caseId) => concat([toBeHex(validatorId, 1), zeroPadValue(toBeHex(caseId), 32)]);
export const asTuple = (s) => ({ version: s.version, intent: s.intent, metadata: s.metadata, homeLedger: s.homeLedger,
  nonHomeLedger: s.nonHomeLedger || EMPTY_LEDGER, userSig: s.userSig || '0x', nodeSig: s.nodeSig || '0x' });

/** JSON-safe copies, for the wire and for storage. */
export const pack = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
export function unpackState(s) {
  const L = (l) => ({ ...l, chainId: BigInt(l.chainId), decimals: Number(l.decimals), userAllocation: BigInt(l.userAllocation), userNetFlow: BigInt(l.userNetFlow), nodeAllocation: BigInt(l.nodeAllocation), nodeNetFlow: BigInt(l.nodeNetFlow) });
  return { ...s, version: BigInt(s.version), intent: Number(s.intent), homeLedger: L(s.homeLedger), nonHomeLedger: s.nonHomeLedger ? L(s.nonHomeLedger) : undefined };
}
export const unpackDef = (d) => ({ ...d, challengeDuration: Number(d.challengeDuration), nonce: BigInt(d.nonce), approvedSignatureValidators: BigInt(d.approvedSignatureValidators) });
