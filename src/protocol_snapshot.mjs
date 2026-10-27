import { Contract, ZeroAddress, getAddress, keccak256 } from 'ethers';
import { readFileSync } from 'node:fs';
export const REGISTRY=getAddress('0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94');
const CORE=getAddress('0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3');
const MANAGER=getAddress('0x7b377ad70a20556f4778c4cd878a68a7e7efabbc');
const PRESET=1778027615735n;
const IMPL='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON='0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const coreAbi=JSON.parse(readFileSync(new URL('./engine/abi/OpenFourCore.json',import.meta.url),'utf8'));
export const toolsAbi=JSON.parse(readFileSync(new URL('./engine/abi/OpenFourTools.json',import.meta.url),'utf8'));
const registryAbi=JSON.parse(readFileSync(new URL('./engine/abi/OpenFourRegistry.json',import.meta.url),'utf8'));
async function fingerprint(provider,address){const [code,impl,beacon]=await Promise.all([
  provider.getCode(address),provider.getStorage(address,IMPL),provider.getStorage(address,BEACON)]);
  if(code==='0x')throw Error('protocol_contract_missing');
  const b=getAddress('0x'+beacon.slice(-40));
  const implementation=b!==ZeroAddress?getAddress(await new Contract(b,['function implementation() view returns(address)'],provider).implementation()):getAddress('0x'+impl.slice(-40));
  const [ic,bc]=await Promise.all([implementation===ZeroAddress?'0x':provider.getCode(implementation),b===ZeroAddress?'0x':provider.getCode(b)]);
  const base=`${keccak256(code)}:${implementation.toLowerCase()}:${ic==='0x'?'-':keccak256(ic)}`;
  return b===ZeroAddress?base:`${base}:${b.toLowerCase()}:${keccak256(bc)}`;
}
export async function fourSnapshot(provider){const registry=new Contract(REGISTRY,registryAbi,provider),core=new Contract(CORE,coreAbi,provider);
  const [toolsAddress,zapAddress,preset,resolved,tokenImpl]=await Promise.all([
    registry.openFourTool(),core.zapRouter(),registry.getPreset(PRESET),registry.resolvePresetImplementations(PRESET),registry.getPresetTokenImpl(PRESET)]);
  const fixed={core:CORE,registry:REGISTRY,tools:toolsAddress,manager:MANAGER,zap:zapAddress};
  const fingerprints=Object.fromEntries(await Promise.all(Object.entries(fixed).map(async([key,address])=>[key,await fingerprint(provider,address)])));
  const modules=[resolved.tokenModule,resolved.vaultModule,resolved.curveModule,resolved.tradeModule,resolved.migrateModule,resolved.customDataModule,tokenImpl].filter(x=>x&&x!==ZeroAddress).map(getAddress);
  const moduleFingerprints=Object.fromEntries(await Promise.all(modules.map(async address=>[address,await fingerprint(provider,address)])));
  return {chainId:56,createdUtc:new Date().toISOString(),toolsAddress,zapAddress,fingerprints,moduleFingerprints,presetConfig:preset.toArray().map(String)};
}
