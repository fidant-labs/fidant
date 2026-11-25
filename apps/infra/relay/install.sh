#!/bin/sh
# Makes an Ubuntu 24.04 server a Fidant relay. Run as root with RELAY_ID, RELAY_NAME and APP_URL set.
set -eux

need() {
  case $2 in
  *[!a-z0-9.:/-]*) ;;
  *) printf '%s\n' "$2" | grep -Eqx "$3" && return ;;
  esac
  echo "fidant-relay: $1 must match ^$3\$" >&2
  exit 1
}
need RELAY_ID "${RELAY_ID-}" '[a-z][a-z0-9]{1,15}'
need RELAY_NAME "${RELAY_NAME-}" '([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?'
need APP_URL "${APP_URL-}" 'https://[a-z0-9.-]+'

# The same retention as the app box. The name must sort after Ubuntu's syslog.conf drop-in.
install -d /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/zz-retention.conf <<'EOF'
[Journal]
MaxRetentionSec=29day
MaxFileSec=1day
ForwardToSyslog=no
EOF
systemctl restart systemd-journald

export DEBIAN_FRONTEND=noninteractive
dpkg -s coturn certbot sqlite3 ufw curl logrotate >/dev/null 2>&1 || {
  # Else the package starts coturn with its default config, which has no auth.
  systemctl mask coturn
  apt-get -o DPkg::Lock::Timeout=600 update
  apt-get -o DPkg::Lock::Timeout=600 install -y coturn certbot sqlite3 ufw curl logrotate
}

private_ip=$(ip -4 -o addr show scope global | awk '{ sub("/.*", "", $4); print $4; exit }')
printf '%s\n' "$private_ip" | grep -Eqx '([0-9]{1,3}\.){3}[0-9]{1,3}'

install -d -m 755 /etc/fidant-relay
if [ ! -e /etc/fidant-relay/relay.key ]; then
  (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /etc/fidant-relay/relay.key.new)
  mv /etc/fidant-relay/relay.key.new /etc/fidant-relay/relay.key
fi
openssl pkey -in /etc/fidant-relay/relay.key -pubout -out /etc/fidant-relay/relay.pub
chmod 644 /etc/fidant-relay/relay.pub
printf 'RELAY_ID=%s\nRELAY_NAME=%s\nAPP_URL=%s\n' "$RELAY_ID" "$RELAY_NAME" "$APP_URL" >/etc/fidant-relay/relay.env
chmod 644 /etc/fidant-relay/relay.env

install -d -m 750 -g turnserver /etc/fidant-relay/tls /var/lib/fidant-relay
# coturn reads the secrets from here; it never sees a database made after it started.
if [ ! -e /var/lib/fidant-relay/turndb ]; then
  (umask 027 && sqlite3 /var/lib/fidant-relay/turndb </usr/share/coturn/schema.sql)
  chgrp turnserver /var/lib/fidant-relay/turndb
  chmod 640 /var/lib/fidant-relay/turndb
fi

external_ip=$(grep '^external-ip=' /etc/turnserver.conf || true)
install -m 640 -g turnserver /dev/null /etc/turnserver.conf.new
cat >>/etc/turnserver.conf.new <<EOF
listening-port=3478
tls-listening-port=443
min-port=49152
max-port=65535
realm=$RELAY_NAME
use-auth-secret
userdb=/var/lib/fidant-relay/turndb
cert=/etc/fidant-relay/tls/turn.crt
pkey=/etc/fidant-relay/tls/turn.key
relay-ip=$private_ip
total-quota=200
no-dtls
no-cli
no-multicast-peers
no-tcp-relay
no-stdout-log
simple-log
log-file=/dev/null
# Never deny the box's own public address: relay-to-relay transfers go through it.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=2002::-2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
if [ -n "$external_ip" ]; then
  printf '%s\n' "$external_ip" >>/etc/turnserver.conf.new
fi
mv /etc/turnserver.conf.new /etc/turnserver.conf

install -d /etc/systemd/system/coturn.service.d
cat >/etc/systemd/system/coturn.service.d/online.conf <<'EOF'
[Unit]
Wants=network-online.target
After=network-online.target
EOF
# Ubuntu's unit runs coturn as turnserver with no capabilities, which can't bind 443.
cat >/etc/systemd/system/coturn.service.d/bind443.conf <<'EOF'
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
EOF

# Reads a hand-out on stdin and gives coturn its secret and the previous one. No set -x: it holds them.
cat >/usr/local/bin/fidant-relay-apply-secret <<'EOF'
#!/bin/sh
set -eu
umask 077
. /etc/fidant-relay/relay.env
dir=/var/lib/fidant-relay
db=$dir/turndb
# Rolls back a journal left by a writer that died, which would make coturn refuse every allocation.
sqlite3 "$db" 'SELECT count(*) FROM turn_secret' >/dev/null
if ! secret=$(base64 -d 2>/dev/null | openssl pkeyutl -decrypt -inkey /etc/fidant-relay/relay.key \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 2>/dev/null && echo .); then
  echo 'fidant-relay: cannot open the secret' >&2
  exit 1
fi
secret=${secret%.}
case $secret in
*[!0-9a-f]*) secret= ;;
esac
if [ ${#secret} -ne 64 ]; then
  echo 'fidant-relay: not a secret' >&2
  exit 1
fi
now=$(date +%s)
current=$(cat "$dir/current" 2>/dev/null || true)
if [ "$secret" != "$current" ]; then
  if [ -n "$current" ]; then
    printf '%s\n' "$now" >"$dir/previous-since"
    mv "$dir/current" "$dir/previous"
  fi
  printf '%s\n' "$secret" >"$dir/current"
fi
if [ -e "$dir/previous" ]; then
  since=$(cat "$dir/previous-since" 2>/dev/null || true)
  case $since in
  '' | *[!0-9]*)
    since=$now
    printf '%s\n' "$now" >"$dir/previous-since"
    ;;
  esac
  if [ $((now - since)) -gt 86400 ]; then
    rm -f "$dir/previous" "$dir/previous-since"
  fi
fi
wanted=$(cat "$dir/current" "$dir/previous" 2>/dev/null | LC_ALL=C sort -u)
have=$(sqlite3 "$db" "SELECT value FROM turn_secret WHERE realm='$RELAY_NAME' ORDER BY value")
# Each write makes coturn refuse new allocations until it commits, so write only a change.
if [ "$wanted" != "$have" ]; then
  {
    echo '.timeout 2000'
    echo 'BEGIN;'
    printf "DELETE FROM turn_secret WHERE realm='%s';\n" "$RELAY_NAME"
    for value in $wanted; do
      printf "INSERT INTO turn_secret(realm,value) VALUES('%s','%s');\n" "$RELAY_NAME" "$value"
    done
    echo 'COMMIT;'
  } | sqlite3 -bail "$db" 2>/dev/null || {
    echo 'fidant-relay: cannot write the secrets' >&2
    exit 1
  }
fi
EOF
chmod 700 /usr/local/bin/fidant-relay-apply-secret

# The app answers unknown paths with its page, so only a body shaped like a hand-out goes on.
cat >/usr/local/bin/fidant-relay-secret <<'EOF'
#!/bin/sh
set -eu
if [ "${1-}" != - ]; then
  . /etc/fidant-relay/relay.env
  { curl -fs --max-time 10 --proto =https "$APP_URL/relay-secret/$RELAY_ID" || echo '!'; } 2>/dev/null |
    /usr/local/bin/fidant-relay-secret -
  exit
fi
body=$(head -c 2049; echo .)
body=${body%.}
[ ${#body} -le 2048 ] || exit 0
body=${body%'
'}
case $body in
'' | *[!A-Za-z0-9+/=]*) exit 0 ;;
esac
printf '%s\n' "$body" | LC_ALL=C grep -Eqx '[A-Za-z0-9+/]+={0,2}' || exit 0
printf '%s\n' "$body" | /usr/local/bin/fidant-relay-apply-secret
EOF
chmod 700 /usr/local/bin/fidant-relay-secret
cat >/etc/systemd/system/fidant-relay-secret.service <<'EOF'
[Unit]
Description=Fetch the relay's secret from the app

[Service]
Type=oneshot
ExecStart=/usr/local/bin/fidant-relay-secret
EOF
cat >/etc/systemd/system/fidant-relay-secret.timer <<'EOF'
[Timer]
OnActiveSec=10s
OnUnitInactiveSec=60s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

# certbot's deploy hook, run on the first certificate and on every renewal. No set -x: it handles a key.
cat >/usr/local/bin/fidant-relay-cert-installed <<'EOF'
#!/bin/sh
set -eu
tls=/etc/fidant-relay/tls
had_cert=no
if [ -e $tls/turn.crt ]; then
  had_cert=yes
fi
install -m 640 -g turnserver /dev/null $tls/turn.key.new
cat "$RENEWED_LINEAGE/privkey.pem" >$tls/turn.key.new
install -m 644 /dev/null $tls/turn.crt.new
cat "$RENEWED_LINEAGE/fullchain.pem" >$tls/turn.crt.new
openssl pkey -pubout -in $tls/turn.key.new >$tls/turn.pub.new
if ! openssl x509 -pubkey -noout -in $tls/turn.crt.new | cmp -s - $tls/turn.pub.new; then
  rm -f $tls/turn.key.new $tls/turn.crt.new $tls/turn.pub.new
  echo "fidant-relay: the certificate and key in $RENEWED_LINEAGE don't match" >&2
  exit 1
fi
rm -f $tls/turn.pub.new
mv $tls/turn.key.new $tls/turn.key
mv $tls/turn.crt.new $tls/turn.crt
# USR2 keeps relayed transfers, but a coturn that started without a certificate opens TLS only on restart.
if systemctl is-active --quiet coturn; then
  if [ "$had_cert" = yes ]; then
    systemctl kill -s USR2 coturn
  else
    systemctl restart coturn
  fi
fi
EOF
chmod 700 /usr/local/bin/fidant-relay-cert-installed

# Gets the first certificate. certbot keeps the hook in the renewal config, and certbot.timer renews.
cat >/usr/local/bin/fidant-relay-cert <<'EOF'
#!/bin/sh
set -eu
. /etc/fidant-relay/relay.env
if [ -d "/etc/letsencrypt/live/$RELAY_NAME" ]; then
  # certbot got the certificate, but its deploy hook never finished.
  if [ ! -e /etc/fidant-relay/tls/turn.crt ]; then
    RENEWED_LINEAGE=/etc/letsencrypt/live/$RELAY_NAME /usr/local/bin/fidant-relay-cert-installed
  fi
  exit 0
fi
# Let's Encrypt pauses a name after 1,152 failed validations, and an unresolvable name fails each one.
if [ -z "$(getent ahostsv4 "$RELAY_NAME" | awk '{ print $1; exit }')" ]; then
  exit 0
fi
exec certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-challenges http -d "$RELAY_NAME" --deploy-hook /usr/local/bin/fidant-relay-cert-installed
EOF
chmod 700 /usr/local/bin/fidant-relay-cert
cat >/etc/systemd/system/fidant-relay-cert.service <<'EOF'
[Unit]
Description=Get the relay's first certificate

[Service]
Type=oneshot
ExecStart=/usr/local/bin/fidant-relay-cert
EOF
# Every 15 minutes: Let's Encrypt allows 5 failed validations per host name an hour.
cat >/etc/systemd/system/fidant-relay-cert.timer <<'EOF'
[Timer]
OnActiveSec=30s
OnUnitInactiveSec=15min

[Install]
WantedBy=timers.target
EOF
# certbot logs each address that reaches port 80. By mtime: rotating a log renames it, which renews its ctime.
echo 'e /var/log/letsencrypt - - - m:29d' >/etc/tmpfiles.d/fidant-relay-letsencrypt.conf

# A public address that isn't on the box (Lightsail's NAT) reaches coturn through the relay's own name.
cat >/usr/local/bin/fidant-relay-address <<'EOF'
#!/bin/sh
set -eu
. /etc/fidant-relay/relay.env
conf=/etc/turnserver.conf
address=$(getent ahostsv4 "$RELAY_NAME" | awk '{ print $1; exit }')
relay_ip=$(sed -n 's/^relay-ip=//p' $conf)
# A failed lookup changes nothing: the restart would drop every relayed transfer.
if [ -z "$address" ] || [ -z "$relay_ip" ]; then
  exit 0
fi
wanted="external-ip=$address/$relay_ip"
if ip -4 -o addr show | grep -qF " $address/"; then
  wanted=
fi
if [ "$wanted" = "$(grep '^external-ip=' $conf || true)" ]; then
  exit 0
fi
install -m 640 -g turnserver /dev/null $conf.new
grep -v '^external-ip=' $conf >>$conf.new
if [ -n "$wanted" ]; then
  printf '%s\n' "$wanted" >>$conf.new
fi
mv $conf.new $conf
systemctl try-restart coturn
EOF
chmod 700 /usr/local/bin/fidant-relay-address
cat >/etc/systemd/system/fidant-relay-address.service <<'EOF'
[Unit]
Description=Keep coturn's external-ip in step with the relay's name

[Service]
Type=oneshot
ExecStart=/usr/local/bin/fidant-relay-address
EOF
cat >/etc/systemd/system/fidant-relay-address.timer <<'EOF'
[Timer]
OnActiveSec=5s
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
EOF

# Logging off: each blocked packet would put its source address in the journal.
ufw logging off
ufw default deny incoming
ufw default allow outgoing
for rule in 22/tcp 80/tcp 443/tcp 3478/tcp 3478/udp 49152:65535/udp; do
  ufw allow "$rule"
done
ufw --force enable

systemctl daemon-reload
systemctl unmask coturn
systemctl enable coturn
systemctl enable --now fidant-relay-secret.timer fidant-relay-cert.timer fidant-relay-address.timer

set +x
echo "fidant-relay: public key for $RELAY_ID"
cat /etc/fidant-relay/relay.pub
echo "fidant-relay: end of public key"
# Last, so a coturn that won't start still leaves the timers running and the key printed.
systemctl restart coturn
