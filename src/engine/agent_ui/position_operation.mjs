// Private, authenticated wallet-node operations. Never invoked by public trade buttons.
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Contract,Interface,getAddress,ZeroAddress,keccak256,formatUnits} from 'ethers';
import {FailoverRpcProvider} from '../rpc_failover.mjs';
import {baw,submitContractCall} from '../wallet_cli.mjs';
import {ABI,FLAP,IFACE,detectAgentToken} from './platforms.mjs';
import {assertProtocolPins} from './protocol_pins.mjs';
import {waitForBrowserApproval} from './approval_gate.mjs';
import {verifyTokenTransfer} from './transfer_receipt.mjs';
const core=JSON.parse(readFileSync(new URL('../abi/OpenFourCore.json',import.meta.url),'utf8'));
const erc=new Interface(['function transfer(address,uint256) returns(bool)']);
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const emit=x=>console.log(JSON.stringify(x));
async function main(){const f=Object.fromEntries(process.argv.slice(2).map(x=>{const m=x.match(/^--([a-z-]+)=(.+)$/);if(!m)throw Error('operation_arguments_invalid');return [m[1],m[2]];}));
  if(Object.keys(f).some(k=>!['token','wallet','action','recipient','intent'].includes(k))||!['claim','transfer'].includes(f.action)||!/^[0-9a-f-]{36}$/i.test(f.intent||''))throw Error('operation_arguments_invalid');
  const token=getAddress(f.token),wallet=getAddress(f.wallet),recipient=f.action==='transfer'?getAddress(f.recipient):null;
  if(recipient&&[ZeroAddress,token,wallet].some(a=>same(a,recipient)))throw Error('transfer_recipient_invalid');
  const dir=process.env.AGENT_TRADE_STATE_DIR||'./data/orders';mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,`position-${f.intent}.json`);
  if(existsSync(file))throw Error('position_operation_already_submitted');
  let state={token,wallet,recipient,action:f.action,intent:f.intent,stage:'preflight'};
  const save=patch=>{Object.assign(state,patch);writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});renameSync(file+'.tmp',file);};
  const p=new FailoverRpcProvider(process.env.BSC_RPC_HTTP||'https://bsc-rpc.publicnode.com',['https://bsc-rpc.publicnode.com','https://bsc-dataseed.bnbchain.org']);
  try{const [addresses,info]=await Promise.all([baw(['wallet','address']),detectAgentToken(p,token,core,wallet)]);
    if(!addresses.addresses?.some(a=>String(a.binanceChainId)==='56'&&same(a.address,wallet)))throw Error('operation_wallet_identity_mismatch');
    await assertProtocolPins(p,info);
    if(f.action==='transfer'&&(info.phase!=='graduated'||!info.pair))throw Error('transfer_requires_verified_external_market');
    const contract=new Contract(token,ABI.ERC20,p);
    async function reconcile(){const candidates=new Set(state.txHash?[state.txHash]:[]);
      if(!candidates.size){const h=await baw(['wallet','tx-history','--type','all','--size','50','--startTime',String(state.startedMs-60000),'--binanceChainId','56']);
        for(const t of h.transactions||[])if(/^0x[0-9a-f]{64}$/i.test(t.txHash||''))candidates.add(t.txHash);}
      for(const hash of candidates){const [tx,r]=await Promise.all([p.getTransaction(hash),p.getTransactionReceipt(hash)]);
        if(!tx||!r||!same(tx.from,wallet)||!same(tx.to,state.to)||tx.value!==0n||keccak256(tx.data)!==state.inputHash||r.blockNumber<state.fromBlock)continue;
        save({txHash:hash,stage:r.status===1?`${state.step}_confirmed`:`${state.step}_reverted`});
        if(r.status!==1)throw Error('position_operation_reverted');return r;
      }return null;
    }
    async function waitReceipt(){for(const end=Date.now()+300000;Date.now()<end;){let r;try{r=await reconcile();}catch(e){if(e.message==='position_operation_reverted')throw e;}
      if(r)return r;await sleep(state.txHash?700:2000);}emit({stage:'receipt_unresolved',txHash:state.txHash,orderId:state.orderId});return null;}
    if(info.platform==='flap'&&info.market&&info.phase!=='curve'){
      const shares=await new Contract(info.market,ABI.FLAP_MARKET,p).sharesOf(wallet);
      if(shares>0n){const before=await contract.balanceOf(wallet),input=IFACE.flapPortal.encodeFunctionData('claim',[info.market]);
        const result=await submitContractCall({from:wallet,to:FLAP.portal,inputData:input,allowAppConfirmation:true,allowMediumRisk:true,
          onPreview:details=>{emit({stage:'claim_preview',...details});return waitForBrowserApproval(details,{from:wallet,to:FLAP.portal,valueWei:0n,inputData:input,step:'claim'});},
          beforeExecute:async preview=>save({step:'claim',stage:'claim_submitting',to:FLAP.portal,inputHash:keccak256(input),
            startedMs:Date.now(),fromBlock:await p.getBlockNumber(),requestId:preview.requestId,txHash:null})});
        save({stage:result.status==='BROADCASTED'?'claim_broadcast':'claim_app_confirmation_pending',txHash:result.txHash||null,orderId:result.orderId||null});emit({stage:state.stage,txHash:state.txHash,orderId:state.orderId});
        if(!await waitReceipt())return;const got=await contract.balanceOf(wallet)-before;
        if(got>0n)emit({stage:'claim_fill',token,txHash:state.txHash,quantityRaw:String(got)});
      }
    }
    if(f.action==='claim'){save({stage:'completed'});emit({stage:'confirmed',token,action:'claim'});return;}
    const [amount,decimals]=await Promise.all([contract.balanceOf(wallet),contract.decimals()]);
    if(amount<=0n)throw Error('no_position_to_transfer');const input=erc.encodeFunctionData('transfer',[recipient,amount]);
    save({step:'transfer',stage:'transfer_submitting',to:token,inputHash:keccak256(input),amountRaw:String(amount),
      startedMs:Date.now(),fromBlock:await p.getBlockNumber(),txHash:null,orderId:null});
    emit({stage:'transfer_submitting',token,recipient,amount:formatUnits(amount,decimals)});
    // Binance enforces its address book and may require App verification.
    let sent;try{sent=await baw(['wallet','send','--amount',formatUnits(amount,decimals),'--recipient',recipient,
      '--binanceChainId','56','--tokenAddress',token,'--gasLevel','MEDIUM'],60000);}
    catch(e){save({stage:'transfer_submission_unknown'});throw e;}
    save({stage:sent.txHash?'transfer_broadcast':'transfer_app_confirmation_pending',txHash:sent.txHash||null,orderId:sent.orderId||null});
    emit({stage:state.stage,txHash:state.txHash,orderId:state.orderId});
    const receipt=await waitReceipt();if(!receipt)return;
    const {received}=verifyTokenTransfer(receipt,{token,wallet,recipient,amount});
    save({stage:'completed',recipientReceivedRaw:String(received)});emit({stage:'transfer_confirmed',token,recipient,txHash:state.txHash,
      sentRaw:String(amount),receivedRaw:String(received)});emit({stage:'confirmed',token,action:'transfer'});
  }finally{p.destroy();}
}
main().catch(e=>{emit({stage:'error',error:/^[a-z][a-z0-9_]{2,100}$/i.test(e.message)?e.message:'position_operation_failed',apiCode:e.details?.apiCode||null});process.exitCode=1;});
