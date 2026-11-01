# Deploy Walleto on EC2 with automatic updates

This setup uses **Ubuntu 24.04 LTS** and Docker. A domain is optional: use an SSH tunnel for private access without one, or a domain and Caddy for a public HTTPS site. An EC2 systemd timer checks this public GitHub repository's `main` branch about once a minute. When its commit changes, the instance builds an image, runs the tests during the build, checks a candidate container, and replaces the running app. It uses no GitHub token or inbound webhook. Direct pushes to `main` also deploy, not just merged pull requests.

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

## Enable server-only .txt processing privately

**Do not enable this while a current browser scan is running.** Restarting or updating the app can interrupt it. Once it finishes, first remove public access to the dashboard and API: close inbound HTTP/HTTPS and port 3000 in the EC2 security group and firewall, and disable any public reverse proxy that exposes this app. Allow SSH only from your own IP. Verify from outside that the app/API cannot be reached publicly, then use the SSH tunnel in section 3A. The worker has no independent account authentication for job creation. Its localhost Host/Origin checks can be spoofed and are not a substitute for private networking. Never use it on a publicly exposed service.

The file contains recovery phrases. It is transferred through SSH and processed in EC2 memory. To show which phrase belongs to each positive-balance address, the worker temporarily stores encrypted copies of all valid phrases while scanning, and retains them while any checks are incomplete so retries can still find matches. Once every check completes, it removes phrases for addresses with no detected positive balance. The phrase ciphertext and encryption key are stored in the same SQLite database on the EC2 volume; this is not end-to-end encryption. Administrators, a compromised EC2 server, SQLite journals, disk snapshots and backups may expose phrases or keys. Deleting a job does not guarantee secure erasure. This app is experimental and unaudited: do not use phrases protecting valuable funds. Public-address tracking is safer.

After the current scan finishes and private access is confirmed, opt in and redeploy the current `main`:

```sh
sudo touch /var/lib/walleto/background-enabled
sudo systemctl start walleto-deploy.service
sudo journalctl -u walleto-deploy.service -n 100 --no-pager
```

This restarts the application. The update script mounts `/var/lib/walleto/background-jobs` into the app, where acknowledged jobs and results persist across container restarts. A stopped EC2 instance does not scan. Disk space, network access and provider availability are still required. Open the dashboard through the SSH tunnel and choose a UTF-8 `.txt` file. Selecting it starts the server upload after you confirm the warning; files are never parsed or scanned locally, and there is no browser fallback. Keep the laptop on until **upload confirmed**; after that EC2 processes it without the browser. Reopen the same browser and SSH URL to see results. Clearing browser storage loses the job access tokens.

Select **Uploaded file** in the main dashboard’s **Portfolio view** to see that job’s paginated wallets, positive assets, progress and retry/delete controls. Additional uploads create separate selectable jobs; one file transfer can occur at a time, and all active jobs share a default of up to 12 concurrent wallet-network checks, capped at three per network. Each check can make multiple provider requests; performance depends on rate limits and network availability. Click an asset to reveal or export its matching retained phrase. The server verifies the phrase matches the address before returning it. Failed or partial checks remain incomplete and can be retried. Jobs uploaded before phrase matching was added have no saved phrases. Old BNB checks that did not include BUSD become incomplete after the upgrade; choose **Retry incomplete checks** to check BUSD on EC2. A finished job also has **Refresh BNB & BUSD** to recheck that network for all addresses. If an older scan discarded a phrase because its BUSD was not detected, the server cannot recover that phrase; re-upload the original file only if the security risks are acceptable and phrase matching is needed. Prices and totals are displayed in INR using cached external rates; outages leave values unavailable rather than guessed.

After all supported checks for a wallet succeed with no detected positive asset, its row is automatically hidden, not deleted. **Restore hidden wallets** restores saved address and check records for the selected job; progress and scan totals include hidden entries. Pending, failed, incomplete and positive-result wallets remain visible. A refresh temporarily shows wallets being rechecked. This is not proof of an empty wallet: unsupported chains, tokens and inscriptions can be missed. Restoring a file wallet does not recover a phrase already pruned under the existing security policy for unmatched results. The first upgrade adds a SQLite visibility column and validates old completed checks; migration time and disk use increase with large jobs. Keep the private job volume available during the upgrade and do not assume database backups securely erase recovery phrases.

To disable background imports, remove the flag and redeploy after active jobs have finished. Existing job files remain on disk until an operator removes them; snapshots and backups may retain copies. Do not remove the volume during an active job.

## Tune private file scan concurrency

After this version is merged and deployed, an EC2 operator can adjust the **single** private worker's in-flight checks. The defaults remain **12 total and 3 per network**, shared across all file jobs. `WALLETO_SCAN_CONCURRENCY` accepts integers from 1–40; `WALLETO_SCAN_PER_NETWORK` accepts 1–8. Values outside those ranges or malformed values are rejected before replacing the running app. These limits control asynchronous wallet/network checks, not OS processes. With five file-scan networks, actual simultaneous checks cannot exceed either the total limit or five times the per-network limit, and may be lower when there is not enough pending work. Each check may make several HTTP requests. More concurrency is not guaranteed to improve speed and may cause provider throttling or more incomplete checks. Do not run multiple Walleto processes or containers against the same SQLite job directory: they do not have distributed job claiming and can duplicate work or interfere with recovery.

**Before changing settings**, verify the private worker is enabled and the app/API are accessible only through the SSH tunnel as described above. Wait for a current upload to say **Upload confirmed**; interrupted uploads cannot resume. Prefer to wait for active scans to finish, as deploying the setting restarts the container. Acknowledged jobs with intact persistent storage should resume from saved checks, but this is not a guarantee against disk or instance failure. Never remove `/var/lib/walleto/background-jobs` or clear the browser's job credentials.

On the EC2 instance, create a systemd override for the deployment service:

```sh
sudo systemctl edit walleto-deploy.service
```

Enter and save the following, starting cautiously with **20 total / 4 per network**:

```ini
[Service]
Environment="WALLETO_SCAN_CONCURRENCY=20"
Environment="WALLETO_SCAN_PER_NETWORK=4"
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

The app logs `Background scanner limits: 20 concurrent checks, 4 per network.` on startup. The deploy service tracks settings as well as the commit, so a changed override causes a redeploy even when `main` is unchanged. Reopen the same browser and private SSH URL; compare completed network checks over time and watch the **incomplete** count. If failures increase or throughput declines, reduce the settings to 12/3 and redeploy. Do not share recovery phrases, job tokens, wallet lists, or sensitive logs while troubleshooting.

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
