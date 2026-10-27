import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { previewRiskState } from './preview_policy.mjs';

const execFileAsync = promisify(execFile);

export class WalletCliError extends Error {
  constructor(code, details) { super(code); this.name = 'WalletCliError'; this.details = details; }
}

export async function baw(args, timeout = 30000, environment = process.env) {
  const env = { ...environment };
  // The official CLI sends the hostname in an HTTP header; normalize non-ASCII
  // display names without changing device MAC, encryption, sessions or signing.
  const compat=fileURLToPath(new URL('./ascii_device.cjs',import.meta.url)).replaceAll('\\','/');
  env.NODE_OPTIONS=[env.NODE_OPTIONS||'',`--require="${compat}"`].filter(Boolean).join(' ');
  const CLI = env.BAW_CLI || fileURLToPath(new URL('../../node_modules/@binance/agentic-wallet/dist/index.js', import.meta.url));
  // The Binance CLI needs its own wallet session, not the dRPC credential.
  delete env.BSC_RPC_HTTP;
  delete env.BSC_RPC_WSS;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [CLI, ...args, '--json'], {
      env, timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    }));
  } catch (error) {
    stdout = error.stdout;
    if (!stdout) throw new WalletCliError(error.killed ? 'cli_timeout' : 'cli_process_failed');
  }
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw new WalletCliError('cli_invalid_json'); }
  if (!response.success) {
    // Never print raw CLI error text: it can contain a URL or untrusted token metadata.
    throw new WalletCliError(`cli_${response.error?.name || response.error?.code || 'rejected'}`, {
      apiCode: response.error?.code, apiName: response.error?.name,
      blockReason: String(response.error?.data?.blockReason ?? '').slice(0, 600),
      preview: previewDiagnostics(response.error?.data || {}),
    });
  }
  return response.data;
}

export function previewDiagnostics(preview) {
  const clean = value => typeof value === 'string' ? value.slice(0, 600) : value;
  const risk = item => Object.fromEntries(['code', 'title', 'description', 'riskType']
    .filter(key => item?.[key] !== undefined).map(key => [key, clean(item[key])]));
  return {
    requestId: preview?.requestId ?? null,
    requireConfirmation: preview?.requireConfirmation === true,
    expiresAt: preview?.expiresAt ?? null,
    simulationCode: preview?.simulationResult?.simulationCode ?? null,
    simulationErrorDetail: clean(preview?.simulationResult?.simulationErrorDetail) ?? null,
    preCheckCode: preview?.simulationResult?.preCheckCode ?? null,
    rawRisks: preview?.risks ?? null,
    rawParsedTx: preview?.parsedTx ?? null,
    parsedTx: Object.fromEntries(['transactionType', 'amount', 'isMax', 'recipient', 'contractAddress']
      .filter(key => ['string', 'number', 'boolean'].includes(typeof preview?.parsedTx?.[key]))
      .map(key => [key, clean(preview.parsedTx[key])])),
    riskDetails: (preview?.risks?.riskDetails || []).map(risk),
    addressRisks: Object.entries(preview?.risks?.addresses || {}).map(([address, details]) => ({
      address, riskLevel: details.riskLevel, riskDetails: (details.riskDetails || []).map(risk),
    })),
    riskBehaviors: (preview?.risks?.riskBehaviors || []).map(risk),
    authorityChangeCount: preview?.simulationResult?.authorityChanges?.length || 0,
  };
}

export function assertPreviewSafety(preview, { allowMediumRisk = false } = {}) {
  if (!preview?.requestId) throw new WalletCliError('preview_missing_request_id');
  if (!preview.simulationResult) throw new WalletCliError('preview_missing_simulation');
  if (preview.simulationResult?.simulationErrorDetail) {
    throw new WalletCliError('preview_simulation_error');
  }
  if (preview.simulationResult?.simulationCode &&
      preview.simulationResult.simulationCode !== '000000000') {
    throw new WalletCliError('preview_simulation_not_successful');
  }
  const riskState = previewRiskState(previewDiagnostics(preview));
  if (riskState === 'blocked' || (riskState === 'medium' && !allowMediumRisk))
    throw new WalletCliError('preview_security_flag');
}

export function assertAutomaticPreview(preview) {
  assertPreviewSafety(preview);
  if (preview.requireConfirmation) throw new WalletCliError('app_confirmation_required');
}

export async function submitContractCall({ from, to, valueWei = 0n, inputData,
  beforeExecute = () => {}, onPreview = () => {}, allowAppConfirmation = false,
  allowMediumRisk = false }, cli = baw) {
  const start = performance.now();
  const preview = await cli([
    'contract-call', 'preview', '--binanceChainId', '56', '--from', from,
    '--to', to, '--value', BigInt(valueWei).toString(), '--inputData', inputData,
  ]);
  const details = previewDiagnostics(preview);
  const acknowledged = await onPreview(details);
  assertPreviewSafety(preview, {
    allowMediumRisk: allowMediumRisk && acknowledged === true,
  });
  if (preview.requireConfirmation && !allowAppConfirmation)
    throw new WalletCliError('app_confirmation_required');
  const previewMs = Math.round(performance.now() - start);
  await beforeExecute(preview);
  const result = await cli(['contract-call', 'execute', '--requestId', preview.requestId]);
  if (allowAppConfirmation && result.status === 'PENDING_CONFIRMATION' && result.orderId) {
    return { status: result.status, orderId: String(result.orderId), requestId: preview.requestId,
      previewMs, totalWalletMs: Math.round(performance.now() - start) };
  }
  if (result.status !== 'BROADCASTED' || !/^0x[0-9a-fA-F]{64}$/.test(result.txHash || '')) {
    throw new WalletCliError(`execute_${result.status || 'unknown'}`);
  }
  return { txHash: result.txHash, status: result.status,
    previewMs, totalWalletMs: Math.round(performance.now() - start) };
}
