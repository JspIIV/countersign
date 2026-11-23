// Compiles Yellow's Nitrolite contracts (vendor/nitrolite, commit b88d511c, the one Yellow deployed as "sandbox v1.3.0"
// on Base Sepolia, unmodified) with the OpenZeppelin commit Nitrolite pins (v5.5.0), and Countersign, with Nitrolite's
// own settings from contracts/foundry.toml: solc 0.8.30, viaIR, optimizer 1,000,000 runs, except ChannelHub at 750 runs
// to stay under the size limit; Foundry's default EVM version for 0.8.30 (prague). ChannelHub links three external
// libraries. The compiler is the official soljson build.
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import url from 'url';

const require = createRequire(import.meta.url);
export const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const solc = require('solc/wrapper')(require(path.join(ROOT, 'tools', 'soljson-v0.8.30.cjs')));
const V = path.join(ROOT, 'vendor');
const NITRO = path.join(V, 'nitrolite', 'contracts');
export const EVM_VERSION = 'prague';
const RUNS = { default: 1_000_000, ChannelHub: 750 };

// Nitrolite's remappings (contracts/remappings.txt), pointed at the pinned commits in vendor/.
const REMAP = [
  ['@openzeppelin/contracts/', path.join(V, 'openzeppelin-contracts', 'contracts')],
  ['nitrolite/', NITRO + path.sep],
  ['src/', path.join(NITRO, 'src') + path.sep],
];
export const SOURCES = {
  ChannelHub: 'src/ChannelHub.sol',
  ChannelEngine: 'src/ChannelEngine.sol',
  EscrowDepositEngine: 'src/EscrowDepositEngine.sol',
  EscrowWithdrawalEngine: 'src/EscrowWithdrawalEngine.sol',
  ECDSAValidator: 'src/sigValidators/ECDSAValidator.sol',
  PremintERC20: 'src/PremintERC20.sol',
  Countersign: 'evm/Countersign.sol',
};
export const LIBRARIES = ['ChannelEngine', 'EscrowDepositEngine', 'EscrowWithdrawalEngine'];

function resolve(p) {
  for (const [from, to] of REMAP) if (p.startsWith(from)) return path.join(to, p.slice(from.length));
  return path.join(ROOT, p);
}
function findImport(p) {
  const f = resolve(p);
  return fs.existsSync(f) ? { contents: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') } : { error: 'not found: ' + p };
}

const cache = {};
/** libs: { ChannelEngine: '0x..', ... } when ChannelHub is to be linked. */
export function compile(name, libs = null) {
  const key = name + (libs ? JSON.stringify(libs) : '');
  if (cache[key]) return cache[key];
  const file = SOURCES[name];
  const settings = {
    viaIR: true, evmVersion: EVM_VERSION, optimizer: { enabled: true, runs: RUNS[name] || RUNS.default },
    outputSelection: { [file]: { [name]: ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.deployedBytecode.linkReferences'] } },
  };
  if (libs) settings.libraries = Object.fromEntries(LIBRARIES.map((l) => [SOURCES[l], { [l]: libs[l] }]));
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { [file]: { content: findImport(file).contents } }, settings,
  }), { import: findImport }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts[file][name];
  cache[key] = {
    abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployed: c.evm.deployedBytecode.object.toLowerCase(),
    refs: c.evm.deployedBytecode.immutableReferences || {}, links: c.evm.deployedBytecode.linkReferences || {},
    unlinked: Object.keys(c.evm.bytecode.linkReferences || {}).length > 0, version: solc.version(),
  };
  return cache[key];
}

if (process.argv[1] && process.argv[1].endsWith('compile.mjs')) {
  fs.mkdirSync(path.join(ROOT, 'evm', 'abi'), { recursive: true });
  for (const n of (process.argv[2] ? process.argv.slice(2) : Object.keys(SOURCES))) {
    const c = compile(n);
    fs.writeFileSync(path.join(ROOT, 'evm', 'abi', n + '.json'), JSON.stringify(c.abi, null, 2));
    console.log(n.padEnd(24), String((c.deployed.length) / 2).padStart(6), 'runtime bytes', c.unlinked ? '(needs linking)' : '', c.version);
  }
}
