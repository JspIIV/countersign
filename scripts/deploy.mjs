// Deploy Countersign end to end on GenLayer Bradbury. On GenLayer Chain (chain 4221): Yellow's Nitrolite exactly as
// Yellow deploys it (ECDSAValidator, the three engine libraries, ChannelHub linked to them, a PremintERC20 test token),
// Countersign, then the court Intelligent Contract, the one time wiring of Countersign to it, and the node's signed
// registration of Countersign as validator id 1 in the hub's registry. Finally the node funds its vault and the user
// gets test tokens. Nitrolite code is unmodified (scripts/verify_evm.mjs).
//   node scripts/deploy.mjs
// Roles: pchg deploys, ppub is the Nitrolite node (the hub's NODE), padv is the user.
import { Wallet, JsonRpcProvider, ContractFactory, Contract, AbiCoder, getBytes, parseUnits } from 'ethers';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { client, fees } from './net.mjs';
import { compile, ROOT } from './compile.mjs';

const KS = path.join(os.homedir(), '.genlayer', 'keystores');
// Keystore passwords come from PCHG, PADV and PPUB in the environment.
const PW = {};
const provider = new JsonRpcProvider('https://rpc.testnet-chain.genlayer.com', 4221);
async function wallet(k) { return (await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, k + '.json'), 'utf8'), process.env[k.toUpperCase()] || PW[k])).connect(provider); }
const deployer = await wallet('pchg'), node = await wallet('ppub'), user = await wallet('padv');

// v1 (id 1, 2026-11-20) keyed filings without the channel; v2 is id 2. See deployment.json "previous".
export const VALIDATOR_ID = Number(process.env.VALIDATOR_ID || 2);
const OUT = path.join(ROOT, 'deployment.json');
const dep = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { network: 'genlayer testnet bradbury phase 2', chain_id: 4221 };
const save = () => fs.writeFileSync(OUT, JSON.stringify(dep, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(ROOT, 'evm', 'abi'), { recursive: true });

async function deploy(key, name, args = [], libs = null) {
  if (dep[key]) return dep[key].address;
  const c = compile(name, libs);
  fs.writeFileSync(path.join(ROOT, 'evm', 'abi', name + '.json'), JSON.stringify(c.abi, null, 2));
  const contract = await new ContractFactory(c.abi, c.bytecode, deployer).deploy(...args);
  await contract.waitForDeployment();
  dep[key] = { address: await contract.getAddress(), tx: contract.deploymentTransaction().hash };
  dep.compiler = c.version;
  save();
  console.log('deployed', key.padEnd(26), dep[key].address);
  return dep[key].address;
}

console.log('deployer', deployer.address, ' node', node.address, ' user', user.address);
dep.roles = { deployer: deployer.address, node: node.address, user: user.address };
const ecdsa = await deploy('ecdsa_validator', 'ECDSAValidator');
const libs = {
  ChannelEngine: await deploy('channel_engine', 'ChannelEngine'),
  EscrowDepositEngine: await deploy('escrow_deposit_engine', 'EscrowDepositEngine'),
  EscrowWithdrawalEngine: await deploy('escrow_withdrawal_engine', 'EscrowWithdrawalEngine'),
};
const hub = await deploy('channel_hub', 'ChannelHub', [ecdsa, node.address], libs);
const token = await deploy('token', 'PremintERC20', ['Test USD', 'tUSD', 6, deployer.address, parseUnits('1000000', 6)]);
const countersign = await deploy('countersign', 'Countersign', [hub]);

if (!dep.court) {
  const c = client(deployer.privateKey);
  const code = fs.readFileSync(path.join(ROOT, 'contracts', 'countersign.py'), 'utf8');
  const hash = await c.deployContract({ code, args: [countersign], fees: await fees(c) });
  console.log('court tx', hash);
  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    const tx = await c.getTransaction({ hash });
    if (['ACCEPTED', 'FINALIZED'].includes(tx.statusName)) {
      if (tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') { console.error('court deploy failed', tx.txExecutionResultName); process.exit(1); }
      dep.court = { address: tx.txDataDecoded?.contractAddress || tx.recipient, tx: hash };
      dep.address = dep.court.address; dep.tx = hash; dep.deployed_at = new Date().toISOString();
      save();
      console.log('deployed court'.padEnd(35), dep.court.address);
      break;
    }
  }
  if (!dep.court) { console.error('court deploy did not finish'); process.exit(1); }
}

const cs = new Contract(countersign, compile('Countersign').abi, deployer);
if (!dep.wired) {
  await (await cs.setCourt(dep.court.address)).wait();
  dep.wired = true; save();
  console.log('Countersign wired to the court');
}

// The node registers Countersign as validator VALIDATOR_ID by signing abi.encode(chainid, hub, id, validator); anybody submits.
const hubC = new Contract(hub, compile('ChannelHub', libs).abi, deployer);
if (!dep.validator_registered_at) {
  const msg = AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint8', 'address'], [4221, hub, VALIDATOR_ID, countersign]);
  const sig = await node.signMessage(getBytes(msg));
  const rc = await (await hubC.registerNodeValidator(VALIDATOR_ID, countersign, sig)).wait();
  const block = await provider.getBlock(rc.blockNumber);
  dep.validator_id = VALIDATOR_ID;
  dep.validator_registered_at = block.timestamp;
  dep.validator_active_from = block.timestamp + Number(await hubC.VALIDATOR_ACTIVATION_DELAY());
  save();
  console.log('Countersign registered as validator', VALIDATOR_ID, 'active from', new Date(dep.validator_active_from * 1000).toISOString());
}

// Test money: the user holds tUSD, the node funds its vault so it can pay out what it loses.
const erc = new Contract(token, compile('PremintERC20').abi, deployer);
if (!dep.funded) {
  await (await erc.transfer(user.address, parseUnits('100', 6))).wait();
  await (await erc.transfer(node.address, parseUnits('100', 6))).wait();
  await (await erc.connect(node).approve(hub, parseUnits('100', 6))).wait();
  await (await hubC.connect(node).depositToNode(token, parseUnits('60', 6))).wait();
  dep.funded = true; save();
  console.log('user holds 100 tUSD; node vault holds', (await hubC.getNodeBalance(token)).toString());
}
console.log('done');
