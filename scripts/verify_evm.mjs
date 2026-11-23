// Checks that the Nitrolite code this repo compiles is byte for byte the code Yellow runs, and that what is deployed on
// GenLayer Chain is that same code.
//   node scripts/verify_evm.mjs
// For every contract: fetch the runtime code on chain, take the compiled runtime code, fill the link references
// (external library addresses) and immutable references (constructor values) with the bytes found on chain at those
// positions, cut the CBOR metadata trailer from both, and compare. Every executable byte must match.
import { JsonRpcProvider } from 'ethers';
import fs from 'fs'; import path from 'path';
import { compile, ROOT } from './compile.mjs';

const BASE_SEPOLIA = new JsonRpcProvider('https://sepolia.base.org', 84532);
const GENLAYER = new JsonRpcProvider('https://rpc.testnet-chain.genlayer.com', 4221);

// Yellow's own deployments of commit b88d511c ("sandbox v1.3.0", vendor/nitrolite/contracts/deployments/84532 at HEAD).
const YELLOW = [
  ['ChannelHub', '0x5dba8515af063db0c243c15ece7b99f91459c7c3'],
];

function cutMetadata(hex) {
  const len = parseInt(hex.slice(-4), 16);
  return hex.slice(0, hex.length - 4 - len * 2);
}

function holes(c) {
  const out = [];
  for (const file of Object.values(c.links)) for (const refs of Object.values(file)) for (const r of refs) out.push([r.start, r.length]);
  for (const refs of Object.values(c.refs)) for (const r of refs) out.push([r.start, r.length]);
  return out;
}

export async function check(name, address, provider) {
  const c = compile(name);
  let chain = (await provider.getCode(address)).slice(2).toLowerCase();
  if (!chain) return { name, address, ok: false, why: 'no code' };
  let mine = c.deployed;
  if (mine.length !== chain.length) return { name, address, ok: false, why: `length ${mine.length / 2} vs ${chain.length / 2}` };
  for (const [start, length] of holes(c)) {
    mine = mine.slice(0, start * 2) + chain.slice(start * 2, (start + length) * 2) + mine.slice((start + length) * 2);
  }
  const a = cutMetadata(mine), b = cutMetadata(chain);
  return { name, address, ok: a === b, bytes: a.length / 2, filled: holes(c).length };
}

if (process.argv[1] && process.argv[1].endsWith('verify_evm.mjs')) {
  const rows = [];
  // Only the hub is compared on Yellow's chain: its linked libraries and default validator there were deployed earlier,
  // from a commit with the same sources (5922d170) but other compiler settings, and are reused, so this repo does not
  // claim their bytes. On GenLayer Chain every Nitrolite contract is this repo's build of b88d511c.
  for (const [name, address] of YELLOW) rows.push({ chain: 'Base Sepolia (Yellow)', ...(await check(name, address, BASE_SEPOLIA)) });
  const depFile = path.join(ROOT, 'deployment.json');
  if (fs.existsSync(depFile)) {
    const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
    for (const [name, key] of [['ChannelHub', 'channel_hub'], ['ChannelEngine', 'channel_engine'], ['EscrowDepositEngine', 'escrow_deposit_engine'],
      ['EscrowWithdrawalEngine', 'escrow_withdrawal_engine'], ['ECDSAValidator', 'ecdsa_validator'], ['Countersign', 'countersign']]) {
      if (dep[key]) rows.push({ chain: 'GenLayer Chain', ...(await check(name, dep[key].address, GENLAYER)) });
    }
  }
  for (const r of rows) console.log(r.ok ? 'MATCH' : 'DIFF ', r.chain.padEnd(22), r.name.padEnd(24), r.address, r.why || `${r.bytes} executable bytes, ${r.filled} filled`);
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'verify_evm.json'), JSON.stringify(rows, null, 2));
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}
