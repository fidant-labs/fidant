#!/bin/sh
# Lightsail runs this once as root through /bin/sh after a script of its own, so it must stay POSIX sh.
set -eux

# /privacy promises log lines are deleted after 30 days. The journal is the only log store: it
# rotates at least daily and deletes archived files older than 29 days, and forwards nothing to
# rsyslog's /var/log/syslog, which logrotate would keep for about five weeks. The file name must
# sort after Ubuntu's /usr/lib/systemd/journald.conf.d/syslog.conf (ForwardToSyslog=yes): the last
# drop-in read wins.
install -d /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/zz-retention.conf <<'EOF'
[Journal]
MaxRetentionSec=29day
MaxFileSec=1day
ForwardToSyslog=no
EOF
systemctl restart systemd-journald

fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >>/etc/fstab

# Caddy from its own apt repository: Ubuntu's 2.6 can't read the PROXY protocol (decision 0010).
# Error-Mode=any stops the boot if that repository can't be read, instead of installing 2.6.
install -d -m 755 /etc/apt/keyrings
curl --retry 5 --retry-all-errors -fsSL -o /etc/apt/keyrings/caddy-stable.asc https://dl.cloudsmith.io/public/caddy/stable/gpg.key
echo 'deb [signed-by=/etc/apt/keyrings/caddy-stable.asc] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' >/etc/apt/sources.list.d/caddy-stable.list

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 -o APT::Update::Error-Mode=any update
apt-get -o DPkg::Lock::Timeout=600 install -y caddy git libatomic1 xz-utils

cd /tmp
dist=https://nodejs.org/dist/latest-v@NODE_MAJOR@.x
curl --retry 5 --retry-all-errors -fsSLO "$dist/SHASUMS256.txt"
tarball=$(awk '/linux-x64\.tar\.xz$/ {print $2}' SHASUMS256.txt)
curl --retry 5 --retry-all-errors -fsSLO "$dist/$tarball"
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
  touch "/opt/sigill/failed-$sha"
  as_sigill "rm -rf $dir"
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
if [ -n "$previous" ]; then
  switch "$previous"
else
  rm -f /opt/sigill/current
  systemctl stop sigill
fi
as_sigill "rm -rf $dir"
exit 1
EOF
chmod 755 /usr/local/bin/sigill-deploy

cat >/usr/local/bin/sigill-credential <<'EOF'
#!/bin/sh
# A drop-in that names a missing credential file stops the app, so the two exist only together.
set -eu
dropin=/etc/systemd/system/sigill.service.d/mail.conf
secret=/etc/sigill/mail-password
case "${1-} ${2-}" in
"mail on")
  printf 'SMTP user name: '
  read -r user
  printf '%s\n' "$user" | grep -Eqx 'AKIA[A-Z2-7]{16}' || { echo 'Not an SES SMTP user name.' >&2; exit 1; }
  trap 'stty echo' EXIT
  trap 'exit 130' INT TERM HUP
  stty -echo
  printf 'SMTP password: '
  read -r password
  stty echo
  echo
  printf '%s\n' "$password" | grep -Eqx '[A-Za-z0-9+/]{44}' || { echo 'Not an SES SMTP password.' >&2; exit 1; }
  install -d -m 700 /etc/sigill
  (umask 077 && printf '%s\n' "$password" >"$secret")
  mkdir -p "${dropin%/*}"
  printf '%s\n' '[Service]' \
    "Environment=MAIL_SMTP_URL=smtps://$user@email-smtp.eu-north-1.amazonaws.com:465" \
    'Environment="MAIL_FROM=Fidant <@MAIL_FROM@>"' \
    'Environment=PUBLIC_ORIGIN=https://@DOMAIN@' \
    "LoadCredential=mail-password:$secret" \
    'Environment=MAIL_PASSWORD_FILE=%d/mail-password' >"$dropin"
  systemctl daemon-reload
  ;;
"mail off")
  rm -f "$dropin"
  systemctl daemon-reload
  rm -f "$secret"
  ;;
*)
  echo 'Usage: sigill-credential mail on|off' >&2
  exit 2
  ;;
esac
systemctl try-restart sigill
EOF
chmod 700 /usr/local/bin/sigill-credential

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
MemorySwapMax=0

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
	https_port 8444
	auto_https disable_redirects
	servers :8444 {
		listener_wrappers {
			proxy_protocol {
				allow 127.0.0.1/32
			}
			tls
		}
		protocols h1 h2
	}
	log default {
		exclude http.log.error tls
	}
}

(hsts) {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}

@DOMAIN@ {
	import hsts
	encode zstd gzip
	reverse_proxy https://127.0.0.1:8443 {
		# Caddy 2.10+ sends an HTTPS upstream its own address as Host; the app's /signal origin
		# check needs the site's.
		header_up Host {host}
		transport http {
			tls_insecure_skip_verify
		}
	}
}

@REDIRECT_NAMES@ {
	import hsts
	redir https://@DOMAIN@{uri} permanent
}

http:// {
	redir https://{host}{uri} permanent
}

turn.@DOMAIN@ {
	respond 404
}
EOF

install -d /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/no-swap.conf <<'EOF'
[Service]
MemorySwapMax=0
EOF

systemctl daemon-reload
systemctl enable sigill
systemctl enable --now sigill-deploy.timer
systemctl restart caddy

# HAProxy holds 443 and routes by SNI without decrypting (decision 0010). No log line: it logs nothing.
systemctl mask haproxy
apt-get -o DPkg::Lock::Timeout=600 install -y haproxy
cat >/etc/haproxy/haproxy.cfg <<'EOF'
global
	# Bind 443 as root, then parse every untrusted ClientHello unprivileged, like Ubuntu's own config.
	user haproxy
	group haproxy
	chroot /var/lib/haproxy
	maxconn 4096

defaults
	mode tcp
	timeout connect 5s
	# Idle limit for the site. The app pings each /signal WebSocket every 30 s.
	timeout client 2m
	timeout server 2m
	timeout client-fin 30s
	timeout server-fin 30s

frontend tls
	bind :::443 v4v6
	# One IPv4 address, or one IPv6 /64 as in decision 0006, holds at most 128 connections: the
	# app's 32 sockets per address with their pages and relay connections, behind one NAT.
	stick-table type ipv6 size 100k expire 2m store conn_cur
	tcp-request connection track-sc0 src,ipmask(32,64)
	tcp-request connection reject if { sc0_conn_cur gt 128 }
	tcp-request inspect-delay 5s
	tcp-request content accept if { req.ssl_hello_type 1 }
	use_backend coturn if { req.ssl_sni -i turn.@DOMAIN@ } !{ req.ssl_alpn acme-tls/1 }
	default_backend caddy

backend coturn
	# A relayed transfer can sit idle for a while: keep it for an hour once routed.
	timeout tunnel 1h
	server coturn 127.0.0.1:5349

backend caddy
	server caddy 127.0.0.1:8444 send-proxy-v2
EOF
systemctl unmask haproxy
systemctl enable haproxy
systemctl restart haproxy

install -d -m 700 /etc/sigill
(umask 077 && openssl rand -hex 32 >/etc/sigill/turn-secret)
private_ip=$(ip -4 -o addr show scope global | awk '{ sub("/.*", "", $4); print $4; exit }')
printf '%s\n' "$private_ip" | grep -Eqx '([0-9]{1,3}\.){3}[0-9]{1,3}'
systemctl mask coturn
apt-get -o DPkg::Lock::Timeout=600 install -y coturn
install -m 640 -g turnserver /dev/null /etc/turnserver.conf
cat >>/etc/turnserver.conf <<'EOF'
@TURNSERVER_CONF@
EOF
# relay-ip: coturn otherwise relays from the address a client came in on, and HAProxy's TLS
# clients come in on 127.0.0.1 (decision 0010).
{ printf 'external-ip=@BOX_ADDRESS@/%s\nrelay-ip=%s\nstatic-auth-secret=' "$private_ip" "$private_ip"; cat /etc/sigill/turn-secret; } >>/etc/turnserver.conf
install -d /etc/systemd/system/coturn.service.d
cat >/etc/systemd/system/coturn.service.d/online.conf <<'EOF'
[Unit]
Wants=network-online.target
After=network-online.target
EOF
systemctl unmask coturn
systemctl enable --now coturn

# Copies Caddy's certificate for turn.@DOMAIN@ to coturn when it changes, and fails while the copy
# expires within 14 days, so it shows in systemctl --failed. No set -x: it handles a key.
cat >/usr/local/sbin/sigill-turn-cert <<'EOF'
#!/bin/sh
set -eu
name=turn.@DOMAIN@
crt=$(ls -t /var/lib/caddy/.local/share/caddy/certificates/*/$name/$name.crt 2>/dev/null | head -n 1)
key=${crt%.crt}.key
if [ -n "$crt" ] && ! cmp -s "$crt" /etc/coturn/turn.crt; then
  # The caddy user owns these files: refuse links, and read them with its rights only.
  if [ -L "$crt" ] || [ -L "$key" ]; then
    echo "refused: a symbolic link in Caddy's certificate directory" >&2
    exit 1
  fi
  had_cert=no
  if [ -e /etc/coturn/turn.crt ]; then
    had_cert=yes
  fi
  install -d /etc/coturn
  install -o turnserver -g turnserver -m 600 /dev/null /etc/coturn/turn.key.new
  runuser -u caddy -- cat "$key" >/etc/coturn/turn.key.new
  install -m 644 /dev/null /etc/coturn/turn.crt.new
  runuser -u caddy -- cat "$crt" >/etc/coturn/turn.crt.new
  # A renewal between the two reads could pair a new certificate with the old key, and the cmp above
  # would never copy again. Refuse such a pair; the next run reads both files afresh.
  openssl pkey -pubout -in /etc/coturn/turn.key.new >/etc/coturn/turn.pub.new
  if ! openssl x509 -pubkey -noout -in /etc/coturn/turn.crt.new | cmp -s - /etc/coturn/turn.pub.new; then
    rm -f /etc/coturn/turn.key.new /etc/coturn/turn.crt.new /etc/coturn/turn.pub.new
    echo "refused: Caddy's certificate and key for $name don't match" >&2
    exit 1
  fi
  rm -f /etc/coturn/turn.pub.new
  mv /etc/coturn/turn.key.new /etc/coturn/turn.key
  mv /etc/coturn/turn.crt.new /etc/coturn/turn.crt
  # USR2 reloads the pair and keeps relayed transfers. A coturn that started without one opens its
  # TLS listener only on restart. A stopped coturn reads the pair when it starts.
  if systemctl is-active --quiet coturn; then
    if [ "$had_cert" = yes ]; then
      systemctl kill -s USR2 coturn
    else
      systemctl restart coturn
    fi
  fi
fi
if [ -e /etc/coturn/turn.crt ] && ! openssl x509 -checkend 1209600 -noout -in /etc/coturn/turn.crt >/dev/null; then
  echo "/etc/coturn/turn.crt expires within 14 days" >&2
  exit 1
fi
EOF
chmod 755 /usr/local/sbin/sigill-turn-cert
cat >/etc/systemd/system/sigill-turn-cert.service <<'EOF'
[Unit]
Description=Copy the relay's certificate from Caddy to coturn

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sigill-turn-cert
EOF
cat >/etc/systemd/system/sigill-turn-cert.timer <<'EOF'
[Timer]
OnActiveSec=1min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now sigill-turn-cert.timer

turn_urls="stun:turn.@DOMAIN@:3478,turn:turn.@DOMAIN@:3478?transport=udp,turns:turn.@DOMAIN@:443?transport=tcp"
ipv6=$(ip -6 -o addr show scope global | awk '{ sub("/.*", "", $4); print $4; exit }')
if printf '%s\n' "$ipv6" | grep -Eqx '[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}'; then
  turn_urls="$turn_urls,stun:[$ipv6]:3478"
fi
if systemctl is-active --quiet coturn; then
  install -d /etc/systemd/system/sigill.service.d
  cat >/etc/systemd/system/sigill.service.d/turn.conf <<EOF
[Service]
Environment=TURN_URLS=$turn_urls
LoadCredential=turn-secret:/etc/sigill/turn-secret
Environment=TURN_SECRET_FILE=%d/turn-secret
EOF
  systemctl daemon-reload
  systemctl try-restart sigill
fi
