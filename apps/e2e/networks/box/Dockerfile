# The POC box (apps/infra/box/user-data.sh) as a container: systemd as PID 1, with the app server,
# HAProxy, Caddy, coturn and rsyslog as services. compose.yaml mounts the repo at /opt/sigill/current and
# the files from boxFiles() in src/stack/box.ts at /box.
# The node stage is also the server container's image (serverImage in src/stack/networks.ts), and
# its major is .node-version's. The Ubuntu release matches the Lightsail blueprint. box.test.ts
# checks all three. Dependabot moves both pins (.github/dependabot.yml).
# node:26-bookworm, not slim: the server's certificate step shells out to openssl.
FROM node:26.13.1-bookworm@sha256:0a7c0471c10988ef5ab64718fa58bf8d5be578b4d20cf42b10b5fa6ccda39ae1 AS node
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
# With recommends, as user-data.sh installs its packages and the cloud image has its own: a
# recommended package can ship a journald drop-in, which is what the box test checks.
# Caddy from its own apt repository, as user-data.sh does: Ubuntu's 2.6 can't read the PROXY
# protocol, and Error-Mode=any fails the build rather than fall back to it.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl \
  && install -d -m 755 /etc/apt/keyrings \
  && curl --retry 5 --retry-all-errors -fsSL -o /etc/apt/keyrings/caddy-stable.asc https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  && echo 'deb [signed-by=/etc/apt/keyrings/caddy-stable.asc] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' >/etc/apt/sources.list.d/caddy-stable.list \
  && apt-get -o APT::Update::Error-Mode=any update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    systemd systemd-sysv rsyslog openssl caddy git libatomic1 xz-utils haproxy coturn \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl enable haproxy caddy coturn rsyslog \
  # compose.yaml runs the box privileged, so the host's /dev is visible, and systemd does not see
  # the container: without this, agetty would take over the host's virtual consoles (getty@,
  # autovt@ from logind) or serial console (serial-getty@ from the getty generator).
  && systemctl mask getty.target getty@.service autovt@.service serial-getty@.service console-getty.service
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN useradd --system --create-home --home-dir /var/lib/sigill --shell /usr/sbin/nologin sigill
STOPSIGNAL SIGRTMIN+3
# The production modes come with the files; turnserver.conf also needs its group and coturn's key
# its owner, as in user-data.sh.
# systemd makes / shared only outside a container, and LoadCredential= needs it: the credentials
# mount is made in a child namespace and must propagate back.
CMD ["sh", "-c", "cp -R /box/. / && chgrp turnserver /etc/turnserver.conf && chown turnserver:turnserver /etc/coturn/turn.key && systemctl enable sigill && mount --make-rshared / && exec /sbin/init"]
