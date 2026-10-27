import { FetchRequest, JsonRpcProvider } from 'ethers';

function transport(url, timeout) {
  const request = new FetchRequest(url);
  request.timeout = timeout;
  request.setThrottleParams({ maxAttempts: 1, slotInterval: 100 });
  return request;
}

// Keep a single ethers provider identity while switching the JSON-RPC transport.
// PublicNode handles current blocks; Blockmachine covers older getLogs ranges.
export class FailoverRpcProvider extends JsonRpcProvider {
  constructor(primaryUrl, fallbackUrls) {
    super(transport(primaryUrl, 2000), 56, { staticNetwork: true, batchStallTime: 1, cacheTimeout: 0 });
    this.fallbacks = fallbackUrls.map(url => new JsonRpcProvider(transport(url, 3000), 56,
      { staticNetwork: true, batchStallTime: 1, cacheTimeout: 0 }));
    this.primaryDownUntil = 0;
    this.fallbackDownUntil = fallbackUrls.map(() => 0);
    this.activeSource = 'primary';
  }

  async _send(payload) {
    const endpoints = [];
    if (Date.now() >= this.primaryDownUntil) endpoints.push({
      label: 'primary', provider: null, index: -1 });
    for (let i = 0; i < this.fallbacks.length; i++) {
      if (Date.now() >= this.fallbackDownUntil[i]) endpoints.push({
        label: `public_${i + 1}`, provider: this.fallbacks[i], index: i });
    }
    if (!endpoints.length) endpoints.push({
      label: `public_${this.fallbacks.length}`, provider: this.fallbacks.at(-1),
      index: this.fallbacks.length - 1 });
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const result = endpoint.provider
          ? await endpoint.provider._send(payload)
          : await super._send(payload);
        const recoverableError = result.find(item => item.error &&
          [15, 429, -32000, -32602, -32005].includes(Number(item.error.code)));
        if (recoverableError) throw new Error(`rpc_${recoverableError.error.code}`);
        this.activeSource = endpoint.label;
        return result;
      } catch (error) {
        lastError = error;
        if (endpoint.index < 0) this.primaryDownUntil = Date.now() + 60000;
        else this.fallbackDownUntil[endpoint.index] = Date.now() + 15000;
      }
    }
    throw lastError;
  }

  destroy() {
    for (const provider of this.fallbacks) provider.destroy();
    super.destroy();
  }
}
