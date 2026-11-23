// Phase 3: the reviewer's path, exactly as the page walks it, with a brand-new wallet and the real node service code
// (api/node.mjs, run in process with the node's key). Resumable (results/flow_state.json).
//   node scripts/prove_flow.mjs
//
//   the wallet gets 10 tUSD from the node's faucet
//   E  bet "Everest above 8,800 m" (Yes -> 10, No -> 2). The node countersigns the opening, then refuses to settle.
//      The wallet claims 10 (Yes)                -> files, asks the court -> SIGNED -> closes alone, gets 10 back
//   F  bet "Everest below 8,000 m". The wallet claims 10 (Yes, false)  -> REFUSED -> the hub rejects the close
//      then claims its honest 2 (No)            -> SIGNED -> closes alone, gets 2 back
//   and the node service's rules: a wrong deposit, no Countersign, an unsigned state, a reused channel, a rich wallet
import { Wallet, JsonRpcProvider, Contract, AbiCoder, MaxUint256, parseUnits, formatUnits, parseEther } from 'ethers';
import fs from 'fs'; import os from 'os'; import path from 'path'; import url from 'url';
import { client, reader } from './net.mjs';
import { BETS, definition, channelId, anchor, closeFor, signedMessage, withValidatorByte, countersigned, asTuple, pack, unpackState } from '../lib/channel.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const KS = path.join(os.homedir(), '.genlayer', 'keystores');
// Keystore passwords come from PCHG, PADV and PPUB in the environment.
const PW = {};
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment.json'), 'utf8'));
const chain = new JsonRpcProvider('https://rpc.testnet-chain.genlayer.com', 4221);
const abi = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'evm', 'abi', n + '.json'), 'utf8'));
const key = async (k) => (await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, k + '.json'), 'utf8'), process.env[k.toUpperCase()] || PW[k])).connect(chain);
const deployer = await key('pchg'), nodeW = await key('ppub');
process.env.NODE_KEY = nodeW.privateKey;
const { default: nodeService, checkOpen } = await import('../api/node.mjs');
const hub = new Contract(dep.channel_hub.address, abi('ChannelHub'), chain);
const cs = new Contract(dep.countersign.address, abi('Countersign'), chain);
const usd = new Contract(dep.token.address, abi('PremintERC20'), chain);
const anybody = reader();
const coder = AbiCoder.defaultAbiCoder();
const U = (v) => parseUnits(String(v), 6);

const STATE = path.join(ROOT, 'results', 'flow_state.json');
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
const out = (st.transcript = []), checks = (st.checks = []), evm = st.evm || (st.evm = []), glTxs = st.txs || (st.txs = []);
const say = (l) => { console.log(l); out.push(l); save(); };
const check = (label, ok, detail = '') => { checks.push({ label, ok: !!ok, detail }); say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' | ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tx(label, fn) { const t = await fn(); await t.wait(); evm.push({ label, hash: t.hash }); save(); return t; }
const revertOf = async (fn) => { try { await fn(); return 'did NOT revert'; } catch (e) { return e.revert?.name || hub.interface.parseError?.(e.data || '0x')?.name || String(e.shortMessage || e.message).slice(0, 80); } };
/** Call the node service the way the page does: a JSON POST. */
async function callNode(op, body = {}) {
  let code = 0, json = null;
  const res = { setHeader() {}, status(c) { code = c; return this; }, json(j) { json = j; return this; }, end() { return this; } };
  await nodeService({ method: 'POST', query: { op }, body: JSON.stringify(pack(body)), url: '/api/node?op=' + op }, res);
  return { code, ...json };
}

// A reviewer's wallet: new, with a little GEN for gas and nothing else.
if (!st.reviewerKey) { st.reviewerKey = Wallet.createRandom().privateKey; save(); }
const me = new Wallet(st.reviewerKey, chain);
const gl = client(me.privateKey);
say('Countersign phase 3: the reviewer\'s path, a new wallet, the real node service');
say(`  reviewer ${me.address} | node ${nodeW.address} | hub ${hub.target} | Countersign ${cs.target} | court ${dep.court.address}`);
if (!st.gas) { await tx('pchg gives the new wallet 1 GEN for gas', () => deployer.sendTransaction({ to: me.address, value: parseEther('1') })); st.gas = true; save(); }
if (!st.nodeFunded) { await tx('pchg funds the node\'s faucet with 300 tUSD', () => usd.connect(deployer).transfer(nodeW.address, U(300))); st.nodeFunded = true; save(); }

say('\nthe faucet');
// Judged once, on the first run: later the wallet's balance has moved through the channels.
if (!st.faucetChecks) {
  const r = await callNode('faucet', { user: me.address });
  const got = (await usd.balanceOf(me.address)) >= U(10);
  const again = await callNode('faucet', { user: me.address });
  st.faucet = r;
  st.faucetChecks = [['a new wallet gets 10 tUSD from the node', r.code === 200 && got, r.tx || r.error], ['a wallet that already holds 10 gets nothing more', again.code === 400, again.error]];
  save();
}
for (const [label, ok, detail] of st.faucetChecks) check(label, ok, detail);
if (!st.approved) { await tx('the wallet approves the hub for tUSD', () => usd.connect(me).approve(hub.target, MaxUint256)); st.approved = true; save(); }

async function open(name, bet) {
  if (st[name]?.opened) return st[name];
  if (!st[name]) {
    const def = definition({ user: me.address, node: nodeW.address, nonce: Date.now(), validatorId: dep.validator_id });
    const a = anchor(usd.target, bet);
    const cid = channelId(def);
    a.userSig = withValidatorByte(await me.signMessage(signedMessage(cid, a)));
    st[name] = pack({ bet, def, anchor: a, cid }); save();
  }
  const c = st[name];
  // Each channel takes the wallet's 10 tUSD: top up from the faucet first, as a reviewer would.
  if ((await usd.balanceOf(me.address)) < U(10)) { const f = await callNode('faucet', { user: me.address }); if (f.code !== 200) throw new Error('faucet: ' + f.error); evm.push({ label: `${name}: the wallet tops up 10 tUSD from the node's faucet`, hash: f.tx }); save(); }
  const r = await callNode('open', { def: c.def, anchor: c.anchor, bet });
  if (r.code !== 200) throw new Error('the node would not open: ' + r.error);
  c.anchor.nodeSig = r.nodeSig; c.terms = r.terms;
  const def = { ...c.def, nonce: BigInt(c.def.nonce), approvedSignatureValidators: BigInt(c.def.approvedSignatureValidators) };
  await tx(`${name}: the wallet opens a channel on Yellow's hub, 10 tUSD, bet "${BETS[bet].title}", the node's opening signature from the service`, () => hub.connect(me).createChannel(def, asTuple(unpackState(c.anchor))));
  c.opened = true; save();
  return c;
}
async function claim(name, share) {
  const c = st[name], k = `${name}_${share}`;
  if (st[k]?.verdict && st[k].verdict !== 'FILED') return st[k];
  const s = closeFor(usd.target, c.bet, share);
  s.userSig = withValidatorByte(await me.signMessage(signedMessage(c.cid, s)));
  if (!st[k]) {
    const r = await callNode('settle', { channelId: c.cid, state: s });
    say(`    ${name}: the wallet asks the node to sign its CLOSE for ${share}: ${r.code} ${r.error}`);
    const id = Number(await cs.caseCount());
    await tx(`${name}: the wallet files its CLOSE for ${share} tUSD on Countersign`, () => cs.connect(me).fileCase(c.cid, asTuple(unpackState(c.anchor)), asTuple(s), c.terms));
    st[k] = { caseId: id, nodeRefused: r.code === 400, state: pack(s) }; save();
  }
  const x = st[k];
  // A round that ends UNDETERMINED (validators could not agree, or a source was unreachable) changes nothing: ask again.
  for (let attempt = 0; attempt < 3; attempt++) {
  if (!x.round) {
    const gasLimit = 300000n, maxGasPrice = 1000000000n, budget = gasLimit * maxGasPrice;
    const feeParams = coder.encode(['uint256', 'uint256'], [gasLimit, maxGasPrice]);
    const messageAllocations = [{ messageType: 0, onAcceptance: false, recipient: cs.target, budget, feeParams }];
    const est = await gl.estimateTransactionFees({ totalMessageFees: budget, messageAllocations });
    x.round = await gl.writeContract({ address: dep.court.address, functionName: 'rule', args: [x.caseId], value: 0n, fees: { distribution: est.distribution, feeValue: est.feeValue, messageAllocations } });
    glTxs.push({ label: `rule ${k} (case ${x.caseId})`, hash: x.round }); save();
  }
  for (let i = 0; i < 120; i++) {
    const t = await anybody.getTransaction({ hash: x.round });
    if (['FINALIZED', 'UNDETERMINED', 'CANCELED'].includes(t.statusName)) { say(`    ${k}: round ${t.statusName}`); break; }
    await sleep(10000);
  }
  for (let i = 0; i < 40 && Number((await cs.getCase(x.caseId)).verdict) === 1; i++) await sleep(5000);
  x.verdict = ['NONE', 'FILED', 'SIGNED', 'REFUSED'][Number((await cs.getCase(x.caseId)).verdict)];
  if (x.verdict !== 'FILED') break;
  say(`    ${k}: the round changed nothing; asking the court again`);
  x.round = null; save();
  }
  x.ruling = JSON.parse(await anybody.readContract({ address: dep.court.address, functionName: 'case', args: [x.caseId] }));
  save();
  return x;
}
async function close(name, share, label) {
  const c = st[name], x = st[`${name}_${share}`];
  const s = { ...unpackState(x.state), nodeSig: countersigned(dep.validator_id, x.caseId) };
  if (x.closed) return;
  const before = await usd.balanceOf(me.address);
  await tx(label, () => hub.connect(me).closeChannel(c.cid, asTuple(s)));
  x.closed = true; x.received = ((await usd.balanceOf(me.address)) - before).toString(); save();
}

say('\nchannel E: a true bet, claimed honestly');
await open('E', 'above8800');
const e = await claim('E', 10);
check('the node refuses to sign the settlement it owes', e.nodeRefused);
check('the court SIGNS the claim of 10: the source shows Yes', e.verdict === 'SIGNED' && e.ruling.verdict === 'SIGNED', String(e.ruling.why || '').slice(0, 140));

say('\nchannel G: another channel on the same bet, claiming the same 10');
// The two CLOSE states have identical signing data: Nitrolite's signing data does not name the channel. v1 keyed filings
// on (stateHash, respondent) and refused this one as AlreadyFiled, so one channel could block another's settlement.
await open('G', 'above8800');
const g = await claim('G', 10);
check('an identical settlement in another channel is its own case (the v1 collision is gone)', g.caseId !== e.caseId && g.verdict === 'SIGNED', `case ${g.caseId} beside E's case ${e.caseId}`);

say('\nchannel F: a false bet, claimed greedily, then honestly');
await open('F', 'below8000');
const f1 = await claim('F', 10);
check('the court REFUSES a claim of 10: the source shows No', f1.verdict === 'REFUSED', String(f1.ruling.why || '').slice(0, 140));
const f2 = await claim('F', 2);
check('the court SIGNS the honest claim of 2', f2.verdict === 'SIGNED', String(f2.ruling.why || '').slice(0, 140));

const now = (await chain.getBlock('latest')).timestamp;
if (now < dep.validator_active_from) {
  say(`\nYellow's hub enforces Countersign v2 from ${new Date(dep.validator_active_from * 1000).toISOString()}; the closes run then.`);
  const early = await revertOf(() => hub.connect(me).closeChannel.staticCall(st.E.cid, asTuple({ ...unpackState(e.state), nodeSig: countersigned(dep.validator_id, e.caseId) })));
  say(`  a close before activation: ${early}`);
} else {
  say("\nYellow's hub, the validator active");
  await close('E', 10, 'E: the wallet closes the channel alone, Countersign standing in for the silent node');
  const [statusE] = await hub.getChannelData(st.E.cid);
  check('the channel is closed and the wallet got its 10 tUSD back, with no node signature', Number(statusE) === 3 && st.E_10.received === U(10).toString(), `received ${formatUnits(st.E_10.received, 6)}`);
  await close('G', 10, 'G: the second channel closes alone with the same settlement');
  check('the second channel on the same terms closes too, paying 10', st.G_10.received === U(10).toString());
  const greedy = { ...unpackState(f1.state), nodeSig: countersigned(dep.validator_id, f1.caseId) };
  const rejected = await revertOf(() => hub.connect(me).closeChannel.staticCall(st.F.cid, asTuple(greedy)));
  check('Yellow\'s hub rejects the close with the refused case as the node\'s signature', rejected === 'IncorrectSignature', rejected);
  await close('F', 2, 'F: the wallet closes with its honest 2 tUSD, Countersign standing in for the node');
  check('the wallet got exactly 2 back; the node keeps the other 8 the terms give it', st.F_2.received === U(2).toString());
}

say('\nthe node service\'s rules (it countersigns openings only)');
const probe = async (mut) => {
  const def = definition({ user: me.address, node: nodeW.address, nonce: 1, validatorId: dep.validator_id });
  const a = anchor(usd.target, 'above8800');
  const body = { def, anchor: a, bet: 'above8800' };
  mut(body);
  body.anchor.userSig = body.anchor.userSig ?? withValidatorByte(await me.signMessage(signedMessage(channelId(body.def), body.anchor)));
  try { await checkOpen(pack(body), nodeW.address); return 'accepted'; } catch (err) { return err.message; }
};
check('a channel that does not approve Countersign is refused', /approve Countersign/.test(await probe((b) => { b.def.approvedSignatureValidators = 0n; })));
check('a first state with another deposit is refused', /exactly the user's 10/.test(await probe((b) => { b.anchor.homeLedger.userAllocation = U(20); b.anchor.homeLedger.userNetFlow = U(20); })));
check('a bet the node does not offer is refused', /unknown bet|committing to the bet/.test(await probe((b) => { b.anchor.metadata = '0x' + '11'.repeat(32); })));
check('a state the user did not sign is refused', /has not signed/.test(await probe((b) => { b.anchor.userSig = withValidatorByte('0x' + '22'.repeat(65)); })));
const reuse = await callNode('open', { def: st.E.def, anchor: { ...st.E.anchor, nodeSig: undefined }, bet: 'above8800' });
check('a channel that already exists is refused', reuse.code === 400 && /already exists/.test(reuse.error), reuse.error);

const passed = checks.filter((c) => c.ok).length;
say(`\n${passed}/${checks.length} checks passed`);
fs.writeFileSync(path.join(ROOT, 'results', 'flow_proof.json'), JSON.stringify({ reviewer: me.address, node: nodeW.address, channels: { E: st.E.cid, G: st.G.cid, F: st.F.cid },
  cases: { E_10: st.E_10, G_10: st.G_10, F_10: st.F_10, F_2: st.F_2 }, checks, evm, genlayer: glTxs, transcript: out }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
process.exit(passed === checks.length ? 0 : 1);
