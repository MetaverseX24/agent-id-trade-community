import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Interface, parseEther, MaxUint256 } from 'ethers';
import { makeWorkflowConsent,checkWorkflowStep } from '../src/engine/agent_ui/workflow_consent.mjs';
import { GANG_PADS,WBNB } from '../src/engine/agent_ui/platforms.mjs';
import { submitContractCall } from '../src/engine/wallet_cli.mjs';
import { waitForBrowserApproval } from '../src/engine/agent_ui/approval_gate.mjs';
const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),pad=GANG_PADS[0].address;
const info={token,quote:WBNB,platform:'gang',pad:'v2'};
const consent=makeWorkflowConsent(info,{action:'buy',budgetBNB:'0.3'},wallet,randomUUID());
const preview={requestId:'unit-preview',simulationCode:'000000000',simulationErrorDetail:null,
  authorityChangeCount:0,riskDetails:[],addressRisks:[],riskBehaviors:[]};
const abi=new Interface(['function approve(address,uint256)']);
test('workflow consent binds wallet, protocol, native budget and exact approval spender',()=>{
  const wrap={from:wallet,to:WBNB,valueWei:parseEther('0.2'),inputData:'0xd0e30db0',step:'wrap'};
  assert.equal(checkWorkflowStep(preview,wrap,consent),parseEther('0.2'));
  assert.throws(()=>checkWorkflowStep(preview,wrap,consent,parseEther('0.2')),/budget/);
  assert.throws(()=>checkWorkflowStep(preview,{...wrap,from:token},consent),/scope/);
  const approval={from:wallet,to:WBNB,valueWei:0n,inputData:abi.encodeFunctionData('approve',[pad,100n]),step:'approve'};
  assert.equal(checkWorkflowStep(preview,approval,consent),0n);
  assert.throws(()=>checkWorkflowStep(preview,{...approval,inputData:abi.encodeFunctionData('approve',[wallet,100n])},consent),/spender/);
  assert.throws(()=>checkWorkflowStep(preview,{...approval,inputData:abi.encodeFunctionData('approve',[pad,MaxUint256])},consent),/allowance/);
  assert.throws(()=>checkWorkflowStep({...preview,riskBehaviors:[{code:'unknown'}]},wrap,consent),/blocked/);
});
test('one order consent runs wrap, bounded approval and buy without intermediate browser input',async()=>{
  process.env.AGENT_WORKFLOW_CONSENT=JSON.stringify(consent);let executes=0,previews=0;
  const cli=async args=>{
    if(args[1]==='preview')return {requestId:`unit-${++previews}`,requireConfirmation:false,
      simulationResult:{simulationCode:'000000000',authorityChanges:[]},risks:{riskDetails:[],addresses:{},riskBehaviors:[]}};
    executes++;return {status:'BROADCASTED',txHash:'0x'+'a'.repeat(64)};
  };
  try{
    for(const ctx of [{from:wallet,to:WBNB,valueWei:parseEther('0.1'),inputData:'0xd0e30db0',step:'wrap'},
      {from:wallet,to:WBNB,valueWei:0n,inputData:abi.encodeFunctionData('approve',[pad,100n]),step:'approve'},
      {from:wallet,to:pad,valueWei:0n,inputData:'0x12345678',step:'buy'}]){
      await submitContractCall({...ctx,allowMediumRisk:true,allowAppConfirmation:true,
        onPreview:details=>waitForBrowserApproval(details,ctx)},cli);
    }
    assert.equal(executes,3);assert.equal(previews,3);
  }finally{delete process.env.AGENT_WORKFLOW_CONSENT;}
});
test('one-click consent retains mandatory Binance App confirmation',async()=>{
  process.env.AGENT_WORKFLOW_CONSENT=JSON.stringify(consent);
  const ctx={from:wallet,to:pad,valueWei:0n,inputData:'0x12345678',step:'buy'};
  const cli=async args=>args[1]==='preview'?{requestId:'unit-app-required',requireConfirmation:true,
    simulationResult:{simulationCode:'000000000',authorityChanges:[]},risks:{riskDetails:[],addresses:{},riskBehaviors:[]}}:
    {status:'PENDING_CONFIRMATION',orderId:'unit-order'};
  try{const result=await submitContractCall({...ctx,allowAppConfirmation:true,allowMediumRisk:true,
    onPreview:details=>waitForBrowserApproval(details,ctx)},cli);assert.equal(result.status,'PENDING_CONFIRMATION');}
  finally{delete process.env.AGENT_WORKFLOW_CONSENT;}
});
