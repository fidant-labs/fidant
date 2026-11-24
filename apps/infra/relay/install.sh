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

systemctl mask coturn
export DEBIAN_FRONTEND=noninteractive
dpkg -s coturn certbot sqlite3 ufw >/dev/null 2>&1 || {
  apt-get -o DPkg::Lock::Timeout=600 update
  apt-get -o DPkg::Lock::Timeout=600 install -y coturn certbot sqlite3 ufw
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
install -m 640 -g turnserver /dev/null /etc/turnserver.conf
cat >>/etc/turnserver.conf <<EOF
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
  printf '%s\n' "$external_ip" >>/etc/turnserver.conf
fi

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
systemctl restart coturn

set +x
echo "fidant-relay: public key for $RELAY_ID"
cat /etc/fidant-relay/relay.pub
echo "fidant-relay: end of public key"
