// Nitrolite states as ChannelHub reads them: channel ids, signing data, signatures with their validator byte.
// Mirrors vendor/nitrolite/contracts/src/Utils.sol (getChannelId, toSigningData, pack) and ECDSAValidator (EIP-191 over
// abi.encode(channelId, signingData)).
import { AbiCoder, keccak256, getBytes, concat, toBeHex, toUtf8Bytes, zeroPadValue } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
export const INTENT = { OPERATE: 0, CLOSE: 1, DEPOSIT: 2, WITHDRAW: 3 };
export const HUB_VERSION = 1;
const LEDGER = 'tuple(uint64 chainId, address token, uint8 decimals, uint256 userAllocation, int256 userNetFlow, uint256 nodeAllocation, int256 nodeNetFlow)';
export const EMPTY_LEDGER = { chainId: 0n, token: '0x0000000000000000000000000000000000000000', decimals: 0, userAllocation: 0n, userNetFlow: 0n, nodeAllocation: 0n, nodeNetFlow: 0n };

/** A ChannelDefinition as the hub hashes it: six static words, then the hub version in the top byte. */
export function channelId(def) {
  const base = keccak256(coder.encode(['uint32', 'address', 'address', 'uint64', 'uint256', 'bytes32'],
    [def.challengeDuration, def.user, def.node, def.nonce, def.approvedSignatureValidators, def.metadata]));
  return '0x' + toBeHex(HUB_VERSION, 1).slice(2) + base.slice(4);
}

export function signingData(s) {
  return coder.encode(['uint64', 'uint8', 'bytes32', LEDGER, LEDGER], [s.version, s.intent, s.metadata, s.homeLedger, s.nonHomeLedger || EMPTY_LEDGER]);
}
export const stateHash = (s) => keccak256(signingData(s));

/** [0x00][EIP-191 signature over abi.encode(channelId, signingData)]: the hub's default ECDSA validator. */
export async function sign(wallet, cid, s) {
  const message = coder.encode(['bytes32', 'bytes'], [cid, signingData(s)]);
  return concat(['0x00', await wallet.signMessage(getBytes(message))]);
}
/** [validator id][abi.encode(caseId)]: Countersign standing in for the party that refused. */
export const countersigned = (validatorId, caseId) => concat([toBeHex(validatorId, 1), zeroPadValue(toBeHex(caseId), 32)]);

export const termsHash = (terms) => keccak256(toUtf8Bytes(terms));
export const ledger = (chainId, token, decimals, userAllocation, userNetFlow, nodeAllocation = 0n, nodeNetFlow = 0n) =>
  ({ chainId: BigInt(chainId), token, decimals, userAllocation, userNetFlow, nodeAllocation, nodeNetFlow });
/** A state as the hub's ABI takes it. */
export const asTuple = (s) => ({ version: s.version, intent: s.intent, metadata: s.metadata, homeLedger: s.homeLedger,
  nonHomeLedger: s.nonHomeLedger || EMPTY_LEDGER, userSig: s.userSig || '0x', nodeSig: s.nodeSig || '0x' });
