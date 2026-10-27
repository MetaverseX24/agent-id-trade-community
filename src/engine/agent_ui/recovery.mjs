import { getAddress, keccak256 } from 'ethers';

const same = (a, b) => getAddress(a) === getAddress(b);

// An approval completed before the trade preview is safe to retry. Verify the
// exact recorded transaction on chain; never reuse an uncertain sell attempt.
export async function canRetryAfterApproval(provider, prior, wallet) {
  if (prior?.stage !== 'approve_confirmed' || prior.step !== 'approve' ||
      !/^0x[0-9a-fA-F]{64}$/.test(prior.txHash || '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(prior.inputHash || '') ||
      !Number.isSafeInteger(prior.fromBlock) || prior.fromBlock < 0 ||
      !/^\d+$/.test(String(prior.value)) || !prior.to) return false;
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(prior.txHash),
    provider.getTransactionReceipt(prior.txHash),
  ]);
  return !!tx && !!receipt && !!tx.to && tx.chainId === 56n &&
    tx.blockNumber !== null && tx.blockNumber >= prior.fromBlock &&
    receipt.status === 1 && receipt.blockNumber >= prior.fromBlock &&
    same(tx.from, wallet) && same(tx.to, prior.to) &&
    tx.value === BigInt(prior.value) && keccak256(tx.data) === prior.inputHash;
}
