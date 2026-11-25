# A new Ubuntu server that runs apps/infra/relay/install.sh at boot, with its packages already there.
# Built as sigill-e2e-relay:2; bump that tag in compose.yaml when this file changes.
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    systemd systemd-sysv coturn certbot sqlite3 ufw openssl curl iproute2 logrotate \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl disable coturn \
  # Privileged, like the box: keep agetty off the host's consoles (see box/Dockerfile).
  && systemctl mask getty.target getty@.service autovt@.service serial-getty@.service console-getty.service \
  && printf '%s\n' '[Unit]' 'Wants=network-online.target' 'After=network-online.target' \
    '[Service]' 'Type=oneshot' 'RemainAfterExit=yes' 'EnvironmentFile=/relay-config/env' \
    'ExecStart=/bin/sh /relay/install.sh' '[Install]' 'WantedBy=multi-user.target' \
    >/etc/systemd/system/relay-install.service \
  && systemctl enable relay-install
STOPSIGNAL SIGRTMIN+3
# The run's TLS pair stands in for the certificate the relay would get from Let's Encrypt.
CMD ["sh", "-c", "install -d -m 755 /etc/fidant-relay && install -d -m 750 -g turnserver /etc/fidant-relay/tls && install -m 644 /relay-config/tls/turn.crt /etc/fidant-relay/tls/turn.crt && install -m 640 -g turnserver /relay-config/tls/turn.key /etc/fidant-relay/tls/turn.key && mount --make-rshared / && exec /sbin/init"]
