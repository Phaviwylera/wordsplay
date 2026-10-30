# Walleto

A portfolio dashboard for public EVM, Bitcoin and TRON addresses with an experimental browser-based self-custody wallet. It discovers indexed native balances, tokens and collectibles on Ethereum, Base, Arbitrum and Optimism, and native BTC, TRX and BNB balances on Bitcoin, TRON and BNB Smart Chain. Watch-only addresses are stored in browser local storage; no keys or phrases are needed for tracking. The separate wallet feature can generate or import a recovery phrase locally.

## Run locally

Requires Node.js 20.19 or newer for the development tools. Install dependencies with `npm ci`; no API keys are required.

```sh
npm ci
npm start
# open http://localhost:3000
npm test
```

The app can also be deployed to Vercel. Its `/api/scan` serverless endpoint proxies balance requests to public providers: Blockscout for the four indexed EVM networks, mempool.space for Bitcoin, TronGrid for TRON, and PublicNode for BNB Smart Chain. If the server cannot reach a provider, the browser tries it directly; this fallback requires browser access and CORS permission. The public wallet address is sent to the relevant provider. Provider availability, rate limits, and TronGrid API policies may prevent scans.

## Add watch-only wallets

Use the dashboard's address field to add a public EVM `0x`, Bitcoin mainnet (legacy, SegWit or Taproot), or TRON Base58Check address directly; no wallet name or password is needed. BNB Smart Chain uses a standard EVM `0x` address. Each Bitcoin address is tracked individually, not as a complete multi-address wallet. Testnets and the retired BNB Beacon Chain are not supported. Alternatively, paste seed phrases or select a UTF-8 `.txt` file. Use **one complete English BIP-39 phrase per line** (12, 15, 18, 21 or 24 words), with no fixed phrase-count limit. There is no fixed application-level file-size or pasted-text limit. Large imports may take time; browser memory, local storage, and indexer rate limits can restrict practical capacity. Scans run in a queue with up to eight wallet-network scans at a time; wallet and asset lists are paginated. Text files are read locally in small chunks rather than all at once. Derived public addresses are held in browser memory; importing and scanning many wallets may take a very long time and is constrained by browser memory, storage quotas and indexer rate limits. If browser storage is full, new addresses are available only for the current session. A plain text file with two 12-word phrases on two separate lines is supported, including Windows line endings. Select the file and click **Add & scan**. Blank lines are ignored; a label followed by a colon or a numbered/bulleted prefix is accepted. Valid phrases are imported even if other lines are invalid, and duplicate addresses are skipped. Invalid lines are reported by line number, not echoed. The phrase input and file selection are cleared after each attempt; the original file on your device is not deleted.

The **Generate 12-word phrase** button creates one checksum-valid English BIP-39 phrase locally with 128 bits from the browser's cryptographic random number generator, and appends it to the text box without scanning. Click **Add & scan** to import it through the same path as pasted phrases. The field is cleared on import; save the phrase securely beforehand if you intend to retain access. This experimental, unaudited app is not suitable for generating wallets for valuable funds. A newly generated random wallet will almost certainly have no transaction history or balance.

Only the first Ethereum account (`m/44'/60'/0'/0/0`, empty BIP-39 passphrase) is derived from each phrase. Other derivation paths, additional accounts, non-English wordlists and BIP-39 passphrases are not supported, so a different wallet setup may show a different address. Each derived EVM address is automatically scanned on Ethereum, Base, Arbitrum, Optimism and BNB Smart Chain. Seed imports do not derive Bitcoin or TRON addresses; add those public addresses separately. The app saves only the watch-only addresses in browser local storage and sends those public addresses to the relevant providers; it does not save or send the seed phrases. **A seed phrase grants full control over funds. This app is experimental and unaudited; using a public address is safer. Never import a phrase protecting valuable assets, and never share it in chat.** A compromised browser, extension or deployment could still steal a phrase while it is entered or read. Use HTTPS and only a site and device you trust.

## BIP-39 word reference

Open **BIP-39 words** in the dashboard to browse or search the complete English word list. The 2,048 individual words are stored locally in `public/bip39-english.txt` in the standard order, not as pre-made recovery phrases. Display numbers are one-based; BIP-39 indices are zero-based. The list is for reference only and does not generate, save, or validate recovery phrases. Search runs in the browser; never enter a complete seed phrase into the search field. Source and license information are recorded alongside the list.

## Data limitations

Blockscout provides indexed native assets and tokens on Ethereum, Base, Arbitrum and Optimism, with optional USD prices. Bitcoin, TRON and BNB Smart Chain checks cover **native BTC, TRX and BNB only**, without USD pricing. BEP-20, TRC-20, NFTs, Bitcoin inscriptions and other non-native assets are not discovered there. Bitcoin balance combines confirmed and unconfirmed address activity; it is not the balance of an entire HD wallet. If the Ethereum, Optimism or Arbitrum indexer fails or gives incomplete balances, the app tries PublicNode's `eth_getBalance` RPC for native ETH. If token data is valid, it is retained alongside the verified RPC balance. Otherwise the native-only result is shown without a price and the check remains incomplete and retryable because tokens and NFTs are not covered. If the RPC also fails, no balance is fabricated. Public addresses are sent to the fallback RPC provider. Missing or invalid provider responses are errors, not zero balances. A TRON account that the provider cannot verify is reported as incomplete.

Discovery is limited to supported providers and cannot guarantee every asset on every chain. NFTs are shown as quantities rather than valued. The portfolio total includes only assets with available prices and may be incomplete; failed network scans are reported in the dashboard. Progress is measured in completed network checks, including failures. Transient rate-limit, server and network failures are retried once with a short delay; use **Retry failed checks** for remaining failures. A tick means the applicable checks succeeded, not that all token or inscription holdings were discovered; native-only coverage is labelled. **Remove all wallets** clears watch-list entries and cancels scans after confirmation; it does not delete wallets or funds. **Remove zero-balance wallets is unavailable** while supported networks have native-only coverage, because an apparently empty address may still hold tokens or inscriptions. Failed scans are never classified as zero. The dashboard is watch-only and is not financial advice.

## Deploy to EC2 with automatic updates

For an Ubuntu EC2 instance that automatically checks and deploys the latest merged `main` commit, see [the EC2 setup guide](deploy/ec2/README.md). The deployment files must be merged into `main` and configured on your instance first. No domain is required for private access through an SSH tunnel.

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

This separate legacy feature is available via **Advanced self-custody wallet** in the footer or `/wallet`. It is not needed for watch-only tracking. Open `/wallet` to create or import one Ethereum-derived account (standard `m/44'/60'/0'/0/0` path). Only one self-custody wallet can be saved per browser; importing a different one requires removing the existing browser copy after ensuring its recovery phrase is backed up. BIP-39 passphrases and alternative derivation paths are not supported. The recovery phrase is handled in the browser, and the account is stored as a password-encrypted ethers JSON keystore in browser local storage. The phrase is shown only during creation; write it down offline before continuing. Clearing browser data removes the local wallet, so restoring requires the phrase. The password protects only the stored copy and cannot restore a wallet by itself. Never share a recovery phrase or enter one into an untrusted site. Browser extensions, a compromised device, or a compromised deployment can steal keys even when the stored wallet is encrypted. Use HTTPS and trust the deployment operator.

The wallet can receive at its public EVM address and send **native ETH only** on Ethereum, Base, Arbitrum and Optimism. It relies on public PublicNode RPC endpoints for network data and transaction submission; those providers see the address and signed transactions. Network availability and gas estimates depend on those services. L2 data fees may be additional to the displayed execution-gas estimate. The dashboard can track the wallet after selecting “Track this address on dashboard”. Token transfers, swaps, staking, hardware wallets, multiple accounts, private-key imports, and other Trust Wallet features are not implemented. This is not affiliated with Trust Wallet.

**This is experimental, unaudited software, not a production wallet. Do not use it for valuable funds.** Tests exercise local import, encryption, lock/unlock and tracking with a public test phrase; real network transfers and fee estimates have not been verified in this sandbox. Transactions are irreversible and submitting a transaction can have an uncertain result if the RPC connection fails.
