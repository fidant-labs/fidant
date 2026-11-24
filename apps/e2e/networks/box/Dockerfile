# The POC box (apps/infra/box/user-data.sh) as a container: systemd as PID 1, with the app server,
# Caddy, coturn and rsyslog as services. compose.yaml mounts the repo at /opt/sigill/current and
# the files from boxFiles() in src/stack/box.ts at /box.
# Built as sigill-e2e-box:2; bump that tag in compose.yaml when this file changes.
# The Ubuntu release matches the Lightsail blueprint, and the node binary is serverImage's in
# src/stack/networks.ts; box.test.ts checks both.
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
# With recommends, as user-data.sh installs its packages and the cloud image has its own: a
# recommended package can ship a journald drop-in, which is what the box test checks.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    systemd systemd-sysv rsyslog openssl curl caddy git libatomic1 xz-utils coturn \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl enable caddy coturn rsyslog
COPY --from=node:26.13.1-bookworm@sha256:0a7c0471c10988ef5ab64718fa58bf8d5be578b4d20cf42b10b5fa6ccda39ae1 /usr/local/bin/node /usr/local/bin/node
RUN useradd --system --create-home --home-dir /var/lib/sigill --shell /usr/sbin/nologin sigill
STOPSIGNAL SIGRTMIN+3
# The production modes come with the files; turnserver.conf also needs its group, as in user-data.sh.
# systemd makes / shared only outside a container, and LoadCredential= needs it: the credentials
# mount is made in a child namespace and must propagate back.
CMD ["sh", "-c", "cp -R /box/. / && chgrp turnserver /etc/turnserver.conf && systemctl enable sigill && mount --make-rshared / && exec /sbin/init"]
