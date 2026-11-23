#!/bin/sh
# Lightsail runs this once as root through /bin/sh after a script of its own, so it must stay POSIX sh.
set -eux

fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >>/etc/fstab

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update
apt-get -o DPkg::Lock::Timeout=600 install -y caddy git xz-utils

cd /tmp
dist=https://nodejs.org/dist/latest-v@NODE_MAJOR@.x
curl -fsSLO "$dist/SHASUMS256.txt"
tarball=$(awk '/linux-x64\.tar\.xz$/ {print $2}' SHASUMS256.txt)
curl -fsSLO "$dist/$tarball"
grep " $tarball\$" SHASUMS256.txt | sha256sum -c -
tar --no-same-owner -xJf "$tarball" -C /usr/local --strip-components=1
npm install -g pnpm@@PNPM_VERSION@

useradd --system --create-home --home-dir /var/lib/sigill --shell /usr/sbin/nologin sigill
install -d -o sigill -g sigill /opt/sigill/releases

cat >/usr/local/bin/sigill-deploy <<'EOF'
#!/bin/bash
set -euo pipefail
repo=https://github.com/sigill-labs/sigill.git
sha=$(git ls-remote "$repo" refs/heads/main | awk '$2 == "refs/heads/main" {print $1}')
[[ $sha =~ ^[0-9a-f]{40}$ ]]
dir=/opt/sigill/releases/$sha
previous=$(readlink /opt/sigill/current || true)
[ "$previous" = "$dir" ] && exit 0
[ -e "/opt/sigill/failed-$sha" ] && exit 0
as_sigill() { runuser -u sigill -- env HOME=/var/lib/sigill bash -euo pipefail -c "$1"; }
as_sigill "rm -rf $dir && git clone --quiet --filter=blob:none --no-checkout $repo $dir && cd $dir && git checkout --quiet $sha && pnpm install --frozen-lockfile"
if ! as_sigill "cd $dir && pnpm build"; then
  as_sigill "rm -rf $dir"
  touch "/opt/sigill/failed-$sha"
  exit 1
fi
switch() {
  ln -sfn "$1" /opt/sigill/current.new
  mv -T /opt/sigill/current.new /opt/sigill/current
  systemctl restart sigill
}
switch "$dir"
for _ in $(seq 20); do
  if curl -fsk --max-time 2 -o /dev/null https://127.0.0.1:8443/; then
    as_sigill "ls -1dt /opt/sigill/releases/*/ | tail -n +4 | xargs -r rm -rf --"
    exit 0
  fi
  sleep 1
done
touch "/opt/sigill/failed-$sha"
[ -n "$previous" ] && switch "$previous"
as_sigill "rm -rf $dir"
exit 1
EOF
chmod 755 /usr/local/bin/sigill-deploy

cat >/etc/systemd/system/sigill.service <<'EOF'
[Unit]
Description=Sigill app server

[Service]
User=sigill
WorkingDirectory=/opt/sigill/current
Environment=PORT=8443
ExecStart=/usr/local/bin/node apps/server/src/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/sigill-deploy.service <<'EOF'
[Unit]
Description=Deploy the newest commit on main

[Service]
Type=oneshot
TimeoutStartSec=20min
ExecStart=/usr/local/bin/sigill-deploy
EOF

cat >/etc/systemd/system/sigill-deploy.timer <<'EOF'
[Timer]
OnActiveSec=10s
OnUnitInactiveSec=60s

[Install]
WantedBy=timers.target
EOF

cat >/etc/caddy/Caddyfile <<'EOF'
{
	admin off
	log default {
		exclude http.log.error
	}
}

(hsts) {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}

@DOMAIN@ {
	import hsts
	reverse_proxy https://127.0.0.1:8443 {
		transport http {
			tls_insecure_skip_verify
		}
	}
}

@REDIRECT_NAMES@ {
	import hsts
	redir https://@DOMAIN@{uri} permanent
}
EOF

systemctl daemon-reload
systemctl enable sigill
systemctl enable --now sigill-deploy.timer
systemctl restart caddy
