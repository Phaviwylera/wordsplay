# Walleto

A portfolio dashboard for public EVM wallet addresses with an experimental browser-based self-custody wallet. Add one or more addresses to discover indexed native balances, tokens and collectibles on Ethereum, Base, Arbitrum and Optimism. Watch-only addresses are stored in browser local storage; no keys or phrases are needed for tracking. The separate wallet feature can generate or import a recovery phrase locally.

## Run locally

Requires Node.js 20.19 or newer for the development tools. Install dependencies with `npm ci`; no API keys are required.

```sh
npm ci
npm start
# open http://localhost:3000
npm test
```

The app can also be deployed to Vercel. Its `/api/scan` serverless endpoint proxies requests to each network's public Blockscout instance. If the server cannot reach an indexer, the browser tries the public indexer directly; this fallback requires browser access and CORS permission from the indexer. The public wallet address is sent to Blockscout in either case.

## Data limitations

Balances and optional USD prices come from public Blockscout indexers. Discovery is limited to the four supported networks and the assets indexed by those services; it cannot guarantee every asset on every chain. NFTs are shown as quantities rather than valued. The portfolio total includes only assets with available prices and may be incomplete; failed network scans are reported in the dashboard. Token data and prices can be stale or unavailable. This is not a wallet, a transaction tool, or financial advice.

## Deploy to AWS App Runner

The included Dockerfile packages the app and its API together for App Runner. Deployment requires an AWS account, permissions to use ECR and App Runner, Docker, and the AWS CLI configured locally. AWS resources may incur charges. This project has not been deployed automatically.

1. Choose an AWS region that supports App Runner, and set it below. Create a private ECR repository, build the Linux image, and push it (the repository creation command is needed only once):

   ```sh
   REGION=ap-south-1 # change if needed
   ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   REPO="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/walleto"
   aws ecr create-repository --repository-name walleto --region "$REGION"
   aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
   docker build --platform linux/amd64 -t walleto:latest .
   docker tag walleto:latest "$REPO:latest"
   docker push "$REPO:latest"
   ```

2. In the AWS App Runner console in the same region, create a service using **Container registry → Amazon ECR → Browse** and select the `walleto:latest` image. Allow App Runner to create or use an ECR access role. Configure the service port as **3000**. Use the default public endpoint and outbound internet access, so the server can reach Blockscout. Set health checks to HTTP path `/` (or use the default TCP check).
3. Create the service and wait for it to become healthy. Open the App Runner service URL. Choose automatic deployments if desired, or deploy a newly pushed image manually from the console.

Test the dashboard by importing a public address and checking its balance. No seed phrase or private key should be entered. Local storage is scoped to the deployment's domain, so wallets saved in another preview or domain will need to be added again. If Blockscout is unreachable or prices are missing, the app reports incomplete results rather than guaranteeing a total. App Runner and ECR charges continue until their resources are removed; consult AWS pricing before deploying.


## Experimental self-custody wallet

Choose **Add wallet → Import seed phrase** on the dashboard or open `/wallet?mode=import` to import a BIP-39 English seed phrase (12, 15, 18, 21 or 24 words). Open `/wallet` to create or import one Ethereum-derived account (standard `m/44'/60'/0'/0/0` path). Only one self-custody wallet can be saved per browser; importing a different one requires removing the existing browser copy after ensuring its recovery phrase is backed up. BIP-39 passphrases and alternative derivation paths are not supported. The recovery phrase is handled in the browser, and the account is stored as a password-encrypted ethers JSON keystore in browser local storage. The phrase is shown only during creation; write it down offline before continuing. Clearing browser data removes the local wallet, so restoring requires the phrase. The password protects only the stored copy and cannot restore a wallet by itself. Never share a recovery phrase or enter one into an untrusted site. Browser extensions, a compromised device, or a compromised deployment can steal keys even when the stored wallet is encrypted. Use HTTPS and trust the deployment operator.

The wallet can receive at its public EVM address and send **native ETH only** on Ethereum, Base, Arbitrum and Optimism. It relies on public PublicNode RPC endpoints for network data and transaction submission; those providers see the address and signed transactions. Network availability and gas estimates depend on those services. L2 data fees may be additional to the displayed execution-gas estimate. The dashboard can track the wallet after selecting “Track this address on dashboard”. Token transfers, swaps, staking, hardware wallets, multiple accounts, private-key imports, and other Trust Wallet features are not implemented. This is not affiliated with Trust Wallet.

**This is experimental, unaudited software, not a production wallet. Do not use it for valuable funds.** Tests exercise local import, encryption, lock/unlock and tracking with a public test phrase; real network transfers and fee estimates have not been verified in this sandbox. Transactions are irreversible and submitting a transaction can have an uncertain result if the RPC connection fails.
