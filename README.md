# Walleto

A portfolio dashboard for public EVM, Bitcoin and TRON addresses with an experimental browser-based self-custody wallet. It discovers indexed native balances, tokens and collectibles on Ethereum, Base, Arbitrum and Optimism, and native BTC, TRX and BNB balances on Bitcoin, TRON and BNB Smart Chain. Watch-only addresses and a non-secret seed-import marker are stored in browser local storage; no keys or phrases are needed for tracking. The separate wallet feature can generate or import a recovery phrase locally.

## Run locally

Requires Node.js 22.13 or newer for the development tools and the optional EC2 background worker (which uses the experimental built-in SQLite API). Install dependencies with `npm ci`; no API keys are required.

```sh
npm ci
npm start
# open http://localhost:3000
npm test
```

The app can also be deployed to Vercel. Its `/api/scan` serverless endpoint proxies balance requests to public providers: Blockscout for the four indexed EVM networks, mempool.space for Bitcoin, TronGrid for TRON, and PublicNode for BNB Smart Chain. For manually tracked addresses and pasted phrases only, if the server cannot reach a provider, the browser tries it directly; this fallback requires browser access and CORS permission. Uploaded files never use the browser fallback. The public wallet address is sent to the relevant provider. Provider availability, rate limits, and TronGrid API policies may prevent scans.

## Add watch-only wallets

Use the dashboard's address field to add a public EVM `0x`, Bitcoin mainnet (legacy, SegWit or Taproot), or TRON Base58Check address directly; no wallet name or password is needed. BNB Smart Chain uses a standard EVM `0x` address. Each Bitcoin address is tracked individually, not as a complete multi-address wallet. Testnets and the retired BNB Beacon Chain are not supported.

To add pasted phrases, enter **one complete English BIP-39 phrase per line** (12, 15, 18, 21 or 24 words) and choose **Add pasted phrases**. Pasted phrases are processed locally in the browser; the watch list stores only public addresses and a non-secret seed-import marker. Validated phrases remain in the current tab’s memory for export until you leave, reload, or remove the wallet. Only public addresses are sent to providers. Invalid lines are reported by line number, not echoed; valid lines are still added and duplicate addresses are skipped. Browser memory and storage quotas limit practical pasted-import capacity. Foreground watch-list scans run with up to eight concurrent wallet-network checks and require the browser to remain open.

**Every selected UTF-8 `.txt` file uses the EC2 server-only path.** Selecting a file prompts for confirmation and uploads it directly; the browser does not read, parse, derive addresses from, or scan the file, and it never falls back to local file processing. It works only when the EC2 worker is enabled and the page is accessed through its private SSH tunnel. Keep the laptop on until the app says **Upload confirmed**; afterward the running EC2 worker continues without the laptop. See [EC2 file imports](#ec2-server-only-file-imports-private-opt-in) for setup, limitations, and security requirements.

The **Generate 12-word phrase** button creates one checksum-valid English BIP-39 phrase locally with 128 bits from the browser's cryptographic random number generator, and appends it to the text box without scanning. Choose **Add pasted phrases** to import it through the same local path. The field is cleared on import; the phrase remains in this tab’s memory for export until you leave or reload. Save the phrase securely beforehand if you intend to retain access. This experimental, unaudited app is not suitable for generating wallets for valuable funds. A newly generated random wallet will almost certainly have no transaction history or balance.

For both pasted phrases and uploaded files, only the first Ethereum account (`m/44'/60'/0'/0/0`, empty BIP-39 passphrase) is derived from each phrase. Other derivation paths, additional accounts, non-English wordlists and BIP-39 passphrases are not supported, so a different wallet setup may show a different address. Each derived EVM address is scanned on Ethereum, Base, Arbitrum, Optimism and BNB Smart Chain. Seed imports do not derive Bitcoin or TRON addresses; add those public addresses separately. **A seed phrase grants full control over funds. This app is experimental and unaudited; using a public address is safer. Never import a phrase protecting valuable assets, and never share it in chat.** A compromised browser, extension, deployment or server could steal a phrase. Use only a site and device you trust.

## Export an asset’s wallet

Select any asset with a positive balance in the dashboard to open **Export wallet**. For a public-address-only entry, **Export address only** downloads a text file containing just that address. When a recovery phrase was imported in the current tab, **Export** downloads the matching address and phrase. The phrase is hidden in the dialog until you choose **Reveal phrase**, and an additional confirmation is required before exporting it. Multiple assets and networks belonging to the same address use that address’s corresponding phrase.

For normal seed imports, validated phrases are retained only in the current tab’s memory and are cleared when you leave or reload the page, or remove the wallet from the watch list. Browser storage contains the public address and a non-secret marker that it was imported from a seed, not the phrase. After reload, or for wallets imported before this feature existed, the phrase cannot be recovered from the watch list: re-import the same phrase in this tab to link it to the existing address again. Until then, the dialog offers only the public address. A tracked address with a matching encrypted self-custody wallet can instead be unlocked with its wallet password in the export dialog. Until you unlock it, the export contains only the address. The password and decrypted phrase remain on the device; the unlocked phrase is kept only in the current tab. For an uploaded-file asset, the same dialog retrieves the retained phrase from EC2 only when you explicitly reveal or export it. The server verifies that it derives the displayed address before returning it; exporting requires confirmation. Older jobs without phrase mappings offer address-only exports.

**A phrase export is an unencrypted text file.** Anyone who obtains it can control the wallet. Export only on a trusted device, store the file securely, never share it, and consider device/cloud backups and synchronization. Deleting a file or clearing browser memory does not guarantee secure erasure. The app is experimental and unaudited; browser extensions, compromised scripts or a compromised device can access phrases while they are in memory.

## EC2 server-only file imports (private, opt-in)

The worker must first be deployed and enabled on a private EC2 instance as described in [the EC2 guide](deploy/ec2/README.md); it is disabled by default. Open the dashboard through the private SSH tunnel, choose a UTF-8 `.txt` file, and confirm the security warning. There is no separate overnight button or panel. The browser streams the `File` directly to EC2 without reading or parsing its contents; there is no local-processing fallback if the tunnel or worker is unavailable. Pasted text is not included in the upload. Only one file transfer can be in progress at a time, but multiple acknowledged jobs can continue on EC2 simultaneously.

The main dashboard’s **Portfolio view** selector switches between the local watch list and individual uploaded-file jobs. File progress, paginated wallets, positive assets, filtering, total known value, retries and deletion use the existing dashboard. File addresses are not copied to the browser watch list or rescanned there. Each job is shown separately, avoiding double-counting if files or watch-list entries contain the same address. The browser receives at most 100 asset and 100 wallet entries per page. Old jobs are still accessible with the same browser and SSH URL; jobs created before phrase matching have no saved phrases.

Use one complete English BIP-39 phrase per line, optionally preceded by a label and colon or a numbered/bulleted prefix. Blank lines are ignored; Windows line endings and a UTF-8 BOM are accepted. Duplicate addresses are skipped and invalid lines are counted without echoing their contents. The original file remains on your device. There is no fixed application-level file-size or phrase-count cap, but uploads and scans are limited by available disk, memory, CPU, network and provider rate limits.

**Keep the laptop on until the page says the upload is confirmed.** A transferred percentage of 100% alone is not confirmation; interrupted uploads must be retried, and an ambiguous connection failure may mean the server accepted an inaccessible job. After confirmation, EC2 processes and scans independently even when the browser, SSH tunnel and laptop are off. Reopen the same browser and SSH URL to reconnect. The EC2 instance, persistent volume, network and providers must remain available; stopped instances do not scan. Acknowledged jobs resume from stored progress after container restarts, while failed or partial checks remain incomplete and can be retried. Six provider checks are shared across all file jobs. For example, 80,080 unique addresses require 400,400 checks across five networks. Rate limits, outages, crashes, storage failures and failed deployments can slow or stop work; there is no guarantee a large job finishes overnight. This worker is not supported on Vercel.

**Do not upload valuable recovery phrases.** An SSH tunnel protects the transfer, not the server or browser. EC2 handles complete phrases in memory and temporarily writes an AES-GCM encrypted upload; the temporary upload key is stored on the same EC2 volume while processing. For phrase-to-address matching, the worker temporarily stores encrypted copies of valid phrases and their encryption key in the same SQLite database on that volume. This is not end-to-end encryption and does not protect against server administrators, a compromised EC2 instance, or backups and snapshots. While checks are incomplete, phrases remain available for retry; once all checks complete, phrases for addresses with no detected positive balance are removed from current job records. Positive matches are revealed to the browser only when explicitly requested. SQLite journals, disk snapshots and storage remnants may preserve key material even after logical deletion; deleting a job is not secure erasure. The app does not send phrases to balance providers.

Results and public addresses are stored on EC2; job access tokens are stored in the browser. Clearing browser storage or changing the browser/origin loses access through the UI. There is no account or separate login for creating jobs; **the endpoint must not be exposed to the internet**. Localhost Host/Origin checks are not authentication and can be forged by non-browser clients. Enable the worker only after closing public access to the app and its API and verifying the SSH tunnel. Pasted phrases and manually added addresses remain a separate foreground mode.

## BIP-39 word reference

Open **BIP-39 words** in the dashboard to browse or search the complete English word list. The 2,048 individual words are stored locally in `public/bip39-english.txt` in the standard order, not as pre-made recovery phrases. Display numbers are one-based; BIP-39 indices are zero-based. The list is for reference only and does not generate, save, or validate recovery phrases. Search runs in the browser; never enter a complete seed phrase into the search field. Source and license information are recorded alongside the list.

## Data limitations

Blockscout provides indexed native assets and tokens on Ethereum, Base, Arbitrum and Optimism, with optional USD prices. Bitcoin, TRON and BNB Smart Chain checks cover **native BTC, TRX and BNB only**, without USD pricing. BEP-20, TRC-20, NFTs, Bitcoin inscriptions and other non-native assets are not discovered there. Bitcoin balance combines confirmed and unconfirmed address activity; it is not the balance of an entire HD wallet. If the Ethereum, Optimism or Arbitrum indexer fails or gives incomplete balances, the app tries PublicNode's `eth_getBalance` RPC for native ETH. If token data is valid, it is retained alongside the verified RPC balance. Otherwise the native-only result is shown without a price and the check remains incomplete and retryable because tokens and NFTs are not covered. If the RPC also fails, no balance is fabricated. Public addresses are sent to the fallback RPC provider. Missing or invalid provider responses are errors, not zero balances. A TRON account that the provider cannot verify is reported as incomplete.

Discovery is limited to supported providers and cannot guarantee every asset on every chain. NFTs are shown as quantities rather than valued. The portfolio total includes only assets with available prices and may be incomplete; failed network scans are reported in the dashboard. Progress is measured in completed network checks, including failures. Foreground watch-list scans retry transient rate-limit, server and network failures once with a short delay. File jobs do not automatically retry failed checks; use the dashboard retry control for remaining failures. A tick means the applicable checks succeeded, not that all token or inscription holdings were discovered; native-only coverage is labelled. **Remove all wallets** clears watch-list entries and cancels scans after confirmation; it does not delete wallets or funds. **Remove zero-balance wallets is unavailable** while supported networks have native-only coverage, because an apparently empty address may still hold tokens or inscriptions. Failed scans are never classified as zero. The dashboard is watch-only and is not financial advice.

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

This separate legacy feature is available via **Advanced self-custody wallet** in the footer or `/wallet`. It is not needed for watch-only tracking. Open `/wallet` to create or import one Ethereum-derived account (standard `m/44'/60'/0'/0/0` path). Only one self-custody wallet can be saved per browser; importing a different one requires removing the existing browser copy after ensuring its recovery phrase is backed up. BIP-39 passphrases and alternative derivation paths are not supported. The recovery phrase is handled in the browser, and the account is stored as a password-encrypted ethers JSON keystore in browser local storage. The phrase is shown during creation; write it down offline before continuing. After tracking the address, you can also unlock the matching encrypted wallet from a positive-balance dashboard asset to export its phrase. Clearing browser data removes the local wallet, so restoring requires the phrase. The password protects only the stored copy and cannot restore a wallet by itself. Never share a recovery phrase or enter one into an untrusted site. Browser extensions, a compromised device, or a compromised deployment can steal keys even when the stored wallet is encrypted. Use HTTPS and trust the deployment operator.

The wallet can receive at its public EVM address and send **native ETH only** on Ethereum, Base, Arbitrum and Optimism. It relies on public PublicNode RPC endpoints for network data and transaction submission; those providers see the address and signed transactions. Network availability and gas estimates depend on those services. L2 data fees may be additional to the displayed execution-gas estimate. The dashboard can track the wallet after selecting “Track this address on dashboard”. Token transfers, swaps, staking, hardware wallets, multiple accounts, private-key imports, and other Trust Wallet features are not implemented. This is not affiliated with Trust Wallet.

**This is experimental, unaudited software, not a production wallet. Do not use it for valuable funds.** Tests exercise local import, encryption, lock/unlock and tracking with a public test phrase; real network transfers and fee estimates have not been verified in this sandbox. Transactions are irreversible and submitting a transaction can have an uncertain result if the RPC connection fails.
