// External contract calls wait for the browser to display and approve the preview.
import { previewRiskState } from '../preview_policy.mjs';
import { checkWorkflowStep } from './workflow_consent.mjs';
let usedNative=0n;
const accepted=new Map();

export async function waitForBrowserApproval(preview,context) {
  if (previewRiskState(preview) === 'blocked') return;
  if(process.env.AGENT_WORKFLOW_CONSENT){
    const consent=JSON.parse(process.env.AGENT_WORKFLOW_CONSENT);
    const fingerprint=JSON.stringify([context?.from,context?.to,String(context?.valueWei||0),context?.inputData,context?.step]);
    if(accepted.has(preview.requestId)&&accepted.get(preview.requestId)!==fingerprint)throw Error('workflow_preview_id_reused');
    if(!accepted.has(preview.requestId)){usedNative=checkWorkflowStep(preview,context,consent,usedNative);accepted.set(preview.requestId,fingerprint);}
    console.log(JSON.stringify({stage:'workflow_step_approved',step:context.step,to:context.to,
      valueWei:String(context.valueWei||0),requireConfirmation:preview.requireConfirmation===true}));
    return true;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('browser_approval_timeout')); }, 230000);
    let pending = '';
    const onData = chunk => {
      pending += String(chunk);
      if (pending.length > 128) { cleanup(); reject(new Error('approval_input_invalid')); return; }
      if (!pending.includes('\n')) return;
      const line = pending.slice(0, pending.indexOf('\n')).trim();
      cleanup();
      if (line === 'APPROVE') resolve(true);
      else reject(new Error('browser_approval_rejected'));
    };
    const onEnd = () => { cleanup(); reject(new Error('approval_channel_closed')); };
    function cleanup() {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      process.stdin.unref?.();
    }
    process.stdin.setEncoding('utf8');
    process.stdin.ref?.();
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}
