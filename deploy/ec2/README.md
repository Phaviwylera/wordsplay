# Deploy Walleto on EC2 with automatic updates

This setup uses **Ubuntu 24.04 LTS** and Docker. A domain is optional: use an SSH tunnel or a Tailscale Serve URL for private access without one, or a domain and Caddy for a public HTTPS site. An EC2 systemd timer checks this public GitHub repository's `main` branch about once a minute. When its commit changes, the instance builds an image, runs the tests during the build, checks a candidate container, and replaces the running app. It uses no GitHub token or inbound webhook. Direct pushes to `main` also deploy, not just merged pull requests.

**These deployment files must first be merged into `main`** before the commands below will find them. This is preparation, not an active deployment. The instance must be running with outbound access to GitHub, npm, Docker Hub, balance providers (Blockscout and PublicNode), CoinGecko and ExchangeRate-API (plus certificate services if using public HTTPS). If several commits arrive between checks, the timer deploys the newest one, not necessarily every intermediate commit. Build, test, network or health-check failures prevent that update; the timer retries and the old app stays up or rollback is attempted. Monitor failures rather than assuming every deployment succeeds.

## 1. Launch and secure the instance

1. Launch an Ubuntu Server 24.04 LTS EC2 instance. Choose a size with at least 2 GiB RAM (for example `t3.small`) and at least 20 GiB of EBS storage; builds and Docker cache consume disk. These are starting points, not performance guarantees. Allocate an Elastic IP if you need a stable IP. AWS resources incur charges.
2. For the no-domain SSH tunnel below, allow **TCP 22 only from your own IP**. For a public HTTPS site, also allow TCP 80 and 443 from the internet for the website and certificate issuance. Do not open port 3000 to the internet. Allow outbound HTTPS and DNS. If Ubuntu UFW is enabled, configure it consistently too.
3. Only if using public HTTPS with a domain, point an `A` record for that domain to the instance's public or Elastic IP. Ensure DNS resolves before enabling Caddy.
4. Connect as `ubuntu` using your existing EC2 SSH key. Never paste credentials, seed phrases or SSH keys into chat.

## 2. Install and start the app

Run these commands **on the EC2 instance**, after the deployment files are merged into `main`:

```sh
sudo apt update
sudo apt install -y git docker.io curl
sudo systemctl enable --now docker
sudo mkdir -p /opt/walleto
sudo git clone --branch main https://github.com/Phaviwylera/wordsplay.git /opt/walleto/source
sudo install -m 644 /opt/walleto/source/deploy/ec2/walleto-deploy.service /etc/systemd/system/
sudo install -m 644 /opt/walleto/source/deploy/ec2/walleto-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now walleto-deploy.timer
sudo systemctl start walleto-deploy.service
```

The first build may take several minutes. The checkout under `/opt/walleto/source` is dedicated to automatic deployment and is reset to `origin/main`; do not keep local edits there. The script and checkout are root-owned: **anyone who can change `main` can affect code deployed on the server**. Restrict GitHub write access, require reviewed pull requests and protect `main`. Use a minimally privileged EC2 instance profile; do not store credentials in the repository. Docker builds execute repository-controlled code.

Check the first deployment:

```sh
sudo systemctl status walleto-deploy.timer --no-pager
sudo journalctl -u walleto-deploy.service -n 100 --no-pager
sudo docker ps --filter name=walleto-app
curl -I http://127.0.0.1:3000/
```

## 3A. No domain: access privately through SSH

On **your own computer**, not on the EC2 instance, open a terminal and replace the placeholders with the path to your existing EC2 key file and the instance's public IPv4 address:

```sh
ssh -i /path/to/your-key.pem -o ExitOnForwardFailure=yes -N -L 127.0.0.1:8080:127.0.0.1:3000 ubuntu@YOUR_EC2_PUBLIC_IP
```

Keep that terminal open, then open **http://127.0.0.1:8080/** in a browser on the same computer. The browser connects to your computer's loopback interface and SSH encrypts the connection to EC2. No domain, Caddy, or public inbound ports 80, 443 or 3000 are needed for this option. This URL is private to that computer and isn't a public website; each other device needs its own tunnel. If port 8080 is busy, use `8081:127.0.0.1:3000` instead and open `http://127.0.0.1:8081/`. Stop the tunnel with Ctrl+C when finished. The app still runs and checks for updates on EC2 after you disconnect.

This doesn't make the app audited or protect against a compromised browser, extension or server. **Use only public wallet addresses; do not import valuable seed phrases.** A public website with HTTPS needs a separate public TLS setup; opening the EC2 IP over HTTP is not a safe substitute. The automatic deployment timer works the same way with or without a domain.

## 3B. No domain: access privately with Tailscale Serve

Tailscale Serve gives your EC2 dashboard a stable HTTPS `*.ts.net` URL that works on devices signed into your Tailscale network, without opening inbound web ports or running the app on your laptop. This is **not** an internet-public site: only devices allowed by your tailnet policy can connect. Keep the tailnet limited to people/devices you trust. Use **Serve**, never **Funnel**; Funnel publishes the service to the public internet.

1. Install Tailscale on EC2 using the [official Linux installation instructions](https://tailscale.com/download/linux), then run `sudo tailscale up`. Complete the one-time authorization URL using the Tailscale account you control. Install the Tailscale app on your Windows computer and sign in to the same tailnet. Confirm you can see both devices in the Tailscale admin console and that access rules do not grant unwanted users access. Enable MagicDNS and HTTPS certificates for the tailnet if the admin console prompts you; Serve uses these to provide the `*.ts.net` URL.
2. After the Walleto app has deployed the Tailscale-origin support, enable the private HTTPS proxy on EC2:

   ```sh
   sudo tailscale serve --bg 3000
   sudo tailscale serve status
   ```

   Copy the exact `https://<device>.<tailnet>.ts.net` URL shown by the status command. Serve proxies to the app's existing loopback-bound port; do **not** change the Docker publish binding or open ports 80, 443 or 3000 in the EC2 security group/firewall.
3. Configure the exact URL as the one trusted browser origin. On EC2:

   ```sh
   sudo systemctl edit walleto-deploy.service
   ```

   Add this override, replacing the example with the exact Serve URL (no trailing slash):

   ```ini
   [Service]
   Environment="WALLETO_TRUSTED_ORIGIN=https://walleto-device.example-tailnet.ts.net"
   ```

   Then apply the setting and restart the app through its tested deployment script:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl start walleto-deploy.service
   sudo journalctl -u walleto-deploy.service -n 60 --no-pager
   ```

4. On Windows, ensure Tailscale is connected to the same tailnet, then open the exact HTTPS URL reported by `tailscale serve status`. It should continue working when your terminal closes; no SSH command or local web server needs to stay open. Use a trusted browser and device.

After the version with automatic browser sync is deployed, opening this private `*.ts.net` URL in a new browser automatically synchronizes all acknowledged EC2 jobs and their existing results; it does not upload the files again, start new scans or rotate existing browser tokens. This also works when browser storage is cleared. No admin recovery code is needed for normal new-browser access. Treat the whole allowed tailnet as trusted: any device/person permitted by Tailscale policy can list, view and manage every saved job, including requesting any retained phrase through the explicit reveal action. Limit tailnet membership and access rules accordingly. If automatic sync is unavailable (such as on an older app version), use the manual recovery procedure below.

The app still binds to loopback and accepts the configured Tailscale origin only when it matches exactly. The Host/Origin allowlist is **not authentication**; Tailscale Serve and your tailnet access policy are the network authentication boundary. Do not open the EC2 app port, install a public reverse proxy, or configure Tailscale Funnel. If you remove the override, redeploy; ordinary localhost SSH-tunnel access remains available. Check `sudo tailscale serve status` after a reboot; background Serve settings persist with the Tailscale service.

## Enable server-only .txt processing and generation privately

**Do not enable this while a current browser scan is running.** Restarting or updating the app can interrupt it. Once it finishes, first remove public access to the dashboard and API: close inbound HTTP/HTTPS and port 3000 in the EC2 security group and firewall, and disable any public reverse proxy that exposes this app. Allow SSH only from your own IP. Verify from outside that the app/API cannot be reached publicly, then use the SSH tunnel in section 3A or a Tailscale Serve URL configured as in section 3B. The worker has no independent account authentication for job creation. Its Host/Origin checks can be spoofed and are not a substitute for private networking. Never use it on a publicly exposed service.

Uploaded phrase `.txt` files contain recovery phrases and are transferred through SSH and processed in EC2 memory. Public-address `.csv` batches are a separate job type and must not contain phrases or private keys; the entire CSV is still transferred to EC2 and temporarily stored encrypted with its key on the same volume. Generated combinations are created on EC2 and enter the same encrypted job workflow; they are not put into browser storage or provider requests. To show which phrase belongs to each positive-balance address, the worker temporarily stores encrypted copies of valid phrases while scanning. For uploads it retains them while any checks are incomplete, then removes phrases for zero-result addresses when the entire job completes without errors. A continuously generated wallet's phrase is removed as soon as all its own checks complete successfully with no positive balance; positive and incomplete generated phrases remain encrypted. Restoring a zero-result address does not restore a discarded phrase. The phrase ciphertext and encryption key are stored in the same SQLite database on the EC2 volume; this is not end-to-end encryption. Administrators, a compromised EC2 server, SQLite journals, disk snapshots and backups may expose phrases or keys. Deleting a job does not guarantee secure erasure. This app is experimental and unaudited: do not use phrases protecting valuable funds. Public-address tracking is safer.

After the current scan finishes and private access is confirmed, opt in and redeploy the current `main`:

```sh
sudo touch /var/lib/walleto/background-enabled
sudo systemctl start walleto-deploy.service
sudo journalctl -u walleto-deploy.service -n 100 --no-pager
```

This restarts the application. The update script mounts `/var/lib/walleto/background-jobs` into the app, where acknowledged jobs and results persist across container restarts. A stopped EC2 instance does not scan. Disk space, network access and provider availability are still required. Open the dashboard through the SSH tunnel or configured Tailscale Serve URL and choose a UTF-8 phrase `.txt` file or a public-address `.csv` under **Add wallets → Public address**. Selecting it starts the server upload after you confirm the warning; files are never parsed or scanned locally, and there is no browser fallback. Keep the laptop on until **upload confirmed**; after that EC2 processes it without the browser. Reopen the private EC2 URL to see results; at the Tailscale Serve URL, a new browser automatically synchronizes existing acknowledged jobs. Manual recovery is available only as a fallback for older deployments or when automatic sync cannot be used. Generated scans use the same single worker, encrypted retention, restart recovery and bearer-token safeguards as uploaded jobs.

A public-address CSV can use the compact headers `phrase_line,btc_native_segwit,evm`, the older separate `ethereum`, `bnb_smart_chain` and `base` columns, or generic `address`, `public_address` or `wallet_address` columns. Other columns are ignored; malformed, unsupported or mismatched address cells are counted and never treated as zero. The CSV must be UTF-8 and no larger than 256 MiB. Duplicate EVM entries across columns are deduplicated; each EVM address is scanned on Ethereum, Base, Arbitrum, Optimism and BNB Smart Chain, and each Bitcoin address on Bitcoin. The CSV is never parsed by the browser and its addresses are not copied to the local watch list. Keep the laptop on until the upload is confirmed; acknowledged imports and scans resume from the persistent job directory. Only public addresses should be in this file: never put recovery phrases or private keys in a CSV.

The main dashboard’s **Server scans** workspace shows up to 20 recent jobs side by side; select a tile to open that job’s paginated wallets, positive assets, progress and retry/delete controls. Page through the tiles to reach older saved jobs. On the private EC2 dashboard, **Start automatic generation** continuously creates random, checksum-valid 12-word combinations and sends their derived addresses into the same scanner, targeting up to 100 generated wallets per second. Select the generated scan tile and choose **Stop automatic generation** to stop producing new wallets; queued checks continue. A finished generated job can be resumed with **Resume automatic generation** without deleting its results. The generator runs without the browser and resumes after a worker restart. Five network checks per wallet mean 100 scanned wallets per second would require 500 checks per second, which public providers may not support. Sustaining that target would create 8.64 million wallet records and 43.2 million checks per day, consuming disk even after zero-result phrases are discarded. A 2,000-check backlog pauses generation until scans catch up. If free disk is below 20% or 2 GiB (whichever reserve is larger), generation temporarily pauses and automatically resumes when space recovers; the user can still stop it. There is no automatic stop based on incomplete-check count. Failed or partial checks remain incomplete and are not automatically retried while generation continues; stop generation, allow queued scans to finish, then choose **Retry incomplete checks**. It shares the existing worker queue with uploads, so it may slow other scans. Monitor CPU, free disk, provider failures and the other services on this instance; these limits cannot guarantee available resources. Randomly matching an existing funded wallet is extraordinarily unlikely. Positive checks are saved as they finish, with up to 12 latest assets highlighted under **Recently detected** even if they fall outside the current table page. The rest of the job continues scanning; all earlier positive assets remain in the paginated results. Additional uploads create separate selectable jobs; one file transfer can occur at a time, and all active jobs share a default of up to 32 concurrent wallet-network checks, capped at six per network. Each check can make multiple provider requests; performance depends on rate limits and network availability. For phrase-file and generated jobs, click an asset to reveal or export its matching retained phrase. The server verifies the phrase matches the address before returning it. Public-address CSV jobs have no phrase mappings and export only the public address. Failed or partial checks remain incomplete and can be retried. Jobs uploaded before phrase matching was added have no saved phrases. Old BNB checks that did not include both BUSD and USDT become incomplete after the upgrade; choose **Retry incomplete checks** to check both stablecoins on EC2. A finished job also has **Refresh BNB, BUSD & USDT** to recheck that network for all addresses. If an older scan discarded a phrase because its BUSD was not detected, the server cannot recover that phrase; re-upload the original file only if the security risks are acceptable and phrase matching is needed. Prices and totals are displayed in INR using cached external rates; outages leave values unavailable rather than guessed.

After all supported checks for a wallet succeed with no detected positive asset, its row is automatically hidden, not deleted. **Restore hidden wallets** restores saved address and check records for the selected job; progress and scan totals include hidden entries. Pending, failed, incomplete and positive-result wallets remain visible. A refresh temporarily shows wallets being rechecked. This is not proof of an empty wallet: unsupported chains, tokens and inscriptions can be missed. Restoring a file wallet does not recover a phrase already pruned under the existing security policy for unmatched results. Upgrades add SQLite visibility and recent-positive indexes; migration time and disk use increase with large jobs. The recent-positive index is partial and does not rewrite every old check. Keep the private job volume available during the upgrade and do not assume database backups securely erase recovery phrases.

To disable background imports, remove the flag and redeploy after active jobs have finished. Existing job files remain on disk until an operator removes them; snapshots and backups may retain copies. Do not remove the volume during an active job.

## Reconnect an existing file job

If automatic browser sync is unavailable—for example, the instance is still on an older release—an EC2 administrator can link an acknowledged job to the current private dashboard without uploading the file again. On a current Tailscale Serve deployment, a new browser syncs automatically and this procedure is not needed. The recovery feature must already be merged and deployed to the instance. Deployment replaces the app container: never interrupt an unconfirmed upload, and prefer to wait for active scans. Acknowledged jobs with an intact persistent volume should resume after restart, but disk or deployment failure can still prevent recovery.

1. Keep the private SSH tunnel open and open Walleto on your computer, for example `http://127.0.0.1:8081/`. Use a trusted browser and device.
2. In a **separate SSH session on EC2**, run:

   ```sh
   sudo docker exec -it walleto-app node --no-warnings lib/recover-file-job.js
   ```

3. Choose the job by its displayed creation time (**UTC**) and status. The command prints a one-time code. Paste it only into **Add wallets → Reconnect an existing server job** in the private Walleto dashboard and select **Reconnect**. Choose its tile in **Server scans** if necessary.

The code is valid for ten minutes, single-use, and invalidated by an app restart or by issuing another code for the same job. If it expires or the connection is interrupted, generate another one. It is issued only through a private Unix socket accessible to the app's OS user and EC2/Docker administrators; the HTTP API cannot issue recovery codes. The private same-origin sync route can return the list of acknowledged jobs only through the configured Tailscale Serve origin or a loopback SSH tunnel. The CLI contacts the already-running worker and does not open the job database or start another scanner. Redeeming a code rotates the selected job's primary browser token in the existing worker, invalidating older browser links until those browsers resync, without deleting its records or intentionally interrupting its scan. Other jobs' links are retained. A browser-storage error after redemption requires keeping the page open or issuing another code.

A recovery code and the resulting browser token grant access to that job, potentially including retained phrases. Never put either in a URL, shell command, screenshot, chat, or an untrusted page; protect the EC2 volume and Docker access, and clear sensitive clipboard history. This is not a substitute for keeping the worker private, and it cannot recover a deleted job or an already-pruned phrase.

## Tune private file scan concurrency

After this version is merged and deployed, an EC2 operator can adjust the **single** private worker's in-flight checks. The defaults are **32 total and 6 per network**, shared across all file jobs; tracked-address scans in the browser default to **30 total and 6 per network**. `WALLETO_SCAN_CONCURRENCY` accepts integers from 1–40; `WALLETO_SCAN_PER_NETWORK` accepts 1–8. Values outside those ranges or malformed values are rejected before replacing the running app. These limits control asynchronous wallet/network checks, not OS processes. With five EVM networks, or six networks when a CSV also contains Bitcoin, actual simultaneous checks cannot exceed either the total limit or the number of active networks times the per-network limit, and may be lower when there is not enough pending work. Each check may make several HTTP requests. More concurrency is not guaranteed to improve speed and may cause provider throttling or more incomplete checks. Do not run multiple Walleto processes or containers against the same SQLite job directory: they do not have distributed job claiming and can duplicate work or interfere with recovery.

**Before changing settings**, verify the private worker is enabled and the app/API are accessible only through the SSH tunnel as described above. Wait for a current upload to say **Upload confirmed**. If a transfer result is ambiguous, use its EC2 status check before retrying; do not blindly resend it. Prefer to wait for active scans to finish, as deploying the setting restarts the container. Acknowledged jobs with intact persistent storage should resume from saved checks, but this is not a guarantee against disk or instance failure. Never remove `/var/lib/walleto/background-jobs` or clear the browser's job credentials.

On the EC2 instance, create a systemd override for the deployment service:

```sh
sudo systemctl edit walleto-deploy.service
```

Only add an override if you have measured a need: start with **32 total / 6 per network**, the current EC2 defaults. Increase gradually (never above 40/8), and reduce promptly if provider errors or incomplete checks rise:

```ini
[Service]
Environment="WALLETO_SCAN_CONCURRENCY=32"
Environment="WALLETO_SCAN_PER_NETWORK=6"
```

The automatic deployment timer may run within a minute after the override is saved. To apply it immediately and inspect the result:

```sh
sudo systemctl daemon-reload
sudo systemctl start walleto-deploy.service
sudo journalctl -u walleto-deploy.service -n 60 --no-pager
sudo docker logs --tail 20 walleto-app
sudo docker stats --no-stream walleto-app
df -h /var/lib/walleto
```

The app logs the applied scanner limits on startup (for the sample override: `Background scanner limits: 32 concurrent checks, 6 per network.`). The deploy service tracks settings as well as the commit, so a changed override causes a redeploy even when `main` is unchanged. Reopen the same browser and private EC2 URL; compare completed network checks over time and watch the **incomplete** count. Measure completed checks over time against the incomplete-check count and provider responses; if failures rise or throughput declines, reduce the settings (for example, to 20/4 or 12/3) and redeploy. Do not share recovery phrases, job tokens, wallet lists, or sensitive logs while troubleshooting.

If CPU or memory is saturated during file processing, a larger compatible EC2 instance may help, but increasing vCPUs alone does not change Walleto's check limits and will not remove external provider limits. Resizing generally requires stopping the instance; wait for uploads and preserve the EBS job volume. Public IPs may change without an Elastic IP, and a larger instance can cost more. Secure any EBS snapshot as sensitive: the job database can contain encrypted recovery phrases and their keys.

## 3B. Optional: enable public HTTPS with a domain

Install Caddy first with `sudo apt install -y caddy`. Replace `wallet.example.com` below with your actual DNS name. Do not leave the example domain in the config. On the instance:

```sh
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
wallet.example.com {
    reverse_proxy 127.0.0.1:3000
}
CADDY
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
```

Open `https://wallet.example.com/` after DNS and certificate issuance complete. If TLS fails, inspect `sudo journalctl -u caddy -n 100 --no-pager`, DNS, the security group and any firewall. **Do not enter valuable seed phrases into this unaudited app, even over HTTPS.** Public address tracking is safer. The app's experimental self-custody features are not production-ready.

## 4. Verify future automatic deployments

After a pull request merges to `main`, the timer fetches it and deploys the latest commit. Allow time for the next check, image build and health checks; a brief interruption can occur during the container swap. Inspect status with:

```sh
sudo systemctl list-timers walleto-deploy.timer --all
sudo journalctl -u walleto-deploy.service -n 100 --no-pager
sudo cat /var/lib/walleto/deployed.sha
sudo git -C /opt/walleto/source fetch origin main
sudo git -C /opt/walleto/source rev-parse origin/main
```

The deployed SHA should match `origin/main` after a successful run. For an immediate check run `sudo systemctl start walleto-deploy.service`. To follow a build live, run `sudo journalctl -fu walleto-deploy.service` in another terminal. If a build or candidate health check fails, the currently running image is left in place; if the replacement fails after the swap, the script attempts to restart the previous image. Rollback itself can fail and needs manual intervention. Configure external uptime and disk-space monitoring; this timer does not send alerts. Old app image tags are cleaned up except for the current and previous ones, but Docker build cache still needs monitoring and maintenance.

Changes to the app and deployment script on `main` are fetched automatically. If you change either systemd unit file, reinstall the unit files from `/opt/walleto/source/deploy/ec2/` using the `install` commands above and run `sudo systemctl daemon-reload` and `sudo systemctl restart walleto-deploy.timer`.
