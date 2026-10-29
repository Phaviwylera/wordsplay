# Walleto

A watch-only portfolio dashboard for public EVM wallet addresses. Add one or more addresses to discover indexed native balances, tokens and collectibles on Ethereum, Base, Arbitrum and Optimism. Addresses are stored in the browser's local storage; no private keys or recovery phrases are needed.

## Run locally

Requires Node.js 18 or newer. No dependencies or API keys are required.

```sh
npm start
# open http://localhost:3000
npm test
```

The app can also be deployed to Vercel. Its `/api/scan` serverless endpoint proxies requests to each network's public Blockscout instance. If the server cannot reach an indexer, the browser tries the public indexer directly; this fallback requires browser access and CORS permission from the indexer. The public wallet address is sent to Blockscout in either case.

## Data limitations

Balances and optional USD prices come from public Blockscout indexers. Discovery is limited to the four supported networks and the assets indexed by those services; it cannot guarantee every asset on every chain. NFTs are shown as quantities rather than valued. The portfolio total includes only assets with available prices and may be incomplete; failed network scans are reported in the dashboard. Token data and prices can be stale or unavailable. This is not a wallet, a transaction tool, or financial advice.
