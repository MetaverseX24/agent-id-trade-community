import { readFileSync } from 'node:fs';
import { Contract, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { FLAP, FOUR_CORE, ROUTER, WBNB } from './platforms.mjs';
import {GANG,GANG_ABI,GANG_ROUTER_ABI} from './gang_protocol.mjs';

const PINS = JSON.parse(readFileSync(new URL('./code_pins.json', import.meta.url), 'utf8'));
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const fromWord = word => getAddress(`0x${word.slice(-40)}`);
const same = (a,b) => getAddress(a)===getAddress(b);

async function check(provider,address) {
  const expected=PINS.contracts[address.toLowerCase()];
  if (!expected) throw new Error('protocol_pin_missing');
  const [code,implWord,beaconWord,adminWord] = await Promise.all([
    provider.getCode(address),provider.getStorage(address,IMPL),
    provider.getStorage(address,BEACON),provider.getStorage(address,ADMIN),
  ]);
  if (code==='0x' || keccak256(code)!==expected.codeHash ||
      !same(fromWord(adminWord),expected.admin)) throw new Error('protocol_code_or_admin_changed');
  const beacon=fromWord(beaconWord);
  if (!same(beacon,expected.beacon)) throw new Error('protocol_beacon_changed');
  const impl=beacon===ZeroAddress ? fromWord(implWord) :
    await new Contract(beacon,['function implementation() view returns(address)'],provider).implementation();
  if (!same(impl,expected.implementation)) throw new Error('protocol_implementation_changed');
  if (impl!==ZeroAddress && keccak256(await provider.getCode(impl))!==expected.implementationHash)
    throw new Error('protocol_implementation_code_changed');
  if(expected.reviewedOwner&&!same(await new Contract(address,['function owner() view returns(address)'],provider).owner(),expected.reviewedOwner))throw Error('protocol_owner_changed');
  if(expected.reviewedAdminOwner){const [owner,adminCode]=await Promise.all([
    new Contract(expected.admin,['function owner() view returns(address)'],provider).owner(),provider.getCode(expected.admin)]);
    if(!same(owner,expected.reviewedAdminOwner)||keccak256(adminCode)!==expected.adminCodeHash)
      throw Error('protocol_admin_authority_changed');}
}

export async function assertProtocolPins(provider,info) {
  const addresses = info.platform==='four' ? [FOUR_CORE] :
    info.platform==='flap' ? [FLAP.portal,FLAP.factory,FLAP.reader,...(info.phase==='curve'?[]:[FLAP.standardPortal])] : [info.venue];
  if (info.phase!=='curve' || (info.platform==='flap' && info.quote!==ZeroAddress) ||
      (info.platform==='gang' && !same(info.quote,WBNB))) addresses.push(ROUTER,WBNB);
  if(info.platform==='gang'&&['v3','fair'].includes(info.kind)){
    addresses.push(GANG.registry,GANG.router,GANG.handler,WBNB);
    const p=new Contract(GANG.pad,GANG_ABI,provider),r=new Contract(GANG.router,GANG_ROUTER_ABI,provider);
    const [pad,w,pancake,listed,handler]=await Promise.all([r.pad(),r.wbnb(),r.pancakeRouter(),p.routers(GANG.router),p.taxHandler()]);
    if(!same(pad,GANG.pad)||!same(w,WBNB)||!same(pancake,ROUTER)||!listed||!same(handler,GANG.handler))throw Error('gang_protocol_wiring_changed');
  }
  await Promise.all([...new Set(addresses.map(x=>x.toLowerCase()))].map(x=>check(provider,x)));
}
export async function assertSettlementPins(provider,needsRouter=false){
  await Promise.all((needsRouter?[WBNB,ROUTER]:[WBNB]).map(address=>check(provider,address)));
}
