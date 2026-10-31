'use strict';
// Quotes and the INR exchange rate are obtained from our same-origin API.
// No wallet address or recovery phrase is included in this request.
(function () {
  let state = { data: null, loading: true };
  let inFlight = null; let timer = null; let version = 0;
  const notify = () => window.dispatchEvent(new Event('pricing:update'));
  function snapshot() { return state; }
  function refresh() {
    if (inFlight) return inFlight;
    const current = ++version;
    state = { ...state, loading: true }; notify();
    const pending = (async () => {
      try {
        const response = await fetch('/api/market', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('Market unavailable');
        const data = await response.json();
        if (data?.currency !== 'INR' || !(data.usdToInr === null || (typeof data.usdToInr === 'number' && Number.isFinite(data.usdToInr) && data.usdToInr > 0)) || !data.prices || typeof data.prices !== 'object') throw new Error('Invalid market data');
        if (current === version) state = { data, loading: false };
      } catch (_) { if (current === version) state = { data: null, loading: false }; }
      if (current === version) { notify(); clearTimeout(timer); timer = setTimeout(refresh, 5 * 60 * 1000); }
    })().finally(() => { if (inFlight === pending) inFlight = null; });
    inFlight = pending;
    return pending;
  }
  window.addEventListener('pagehide', () => { version++; clearTimeout(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { inFlight = null; refresh(); } });
  window.pricing = { snapshot, refresh };
  refresh();
})();
