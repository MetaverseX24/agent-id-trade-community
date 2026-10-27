import {Interface} from 'ethers';
const events=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export function verifyTokenTransfer(receipt,{token,wallet,recipient,amount}){
  if(receipt.status!==1||BigInt(amount)<=0n||same(wallet,recipient))throw Error('transfer_receipt_invalid');
  let received=0n,debited=0n;
  for(const log of receipt.logs||[]){if(!same(log.address,token))continue;let a;try{a=events.parseLog(log)?.args;}catch{}if(!a)continue;
    if(same(a.to,recipient))received+=a.value;if(same(a.from,wallet))debited+=a.value;if(same(a.to,wallet))debited-=a.value;}
  if(debited!==BigInt(amount)||received<=0n)throw Error('transfer_receipt_amount_mismatch');
  return {received,debited};
}
