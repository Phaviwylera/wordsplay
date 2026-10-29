# Deploy Walleto on EC2 with automatic updates

This setup uses **Ubuntu 24.04 LTS** and Docker. A domain is optional: use an SSH tunnel for private access without one, or a domain and Caddy for a public HTTPS site. An EC2 systemd timer checks this public GitHub repository's `main` branch about once a minute. When its commit changes, the instance builds an image, runs the tests during the build, checks a candidate container, and replaces the running app. It uses no GitHub token or inbound webhook. Direct pushes to `main` also deploy, not just merged pull requests.

**These deployment files must first be merged into `main`** before the commands below will find them. This is preparation, not an active deployment. The instance must be running with outbound access to GitHub, npm, Docker Hub and Blockscout (plus certificate services if using public HTTPS). If several commits arrive between checks, the timer deploys the newest one, not necessarily every intermediate commit. Build, test, network or health-check failures prevent that update; the timer retries and the old app stays up or rollback is attempted. Monitor failures rather than assuming every deployment succeeds.

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
