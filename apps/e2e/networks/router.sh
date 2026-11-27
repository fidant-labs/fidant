#!/bin/sh
# NAT router between a site network (10.89.x.0/24) and the public network (198.51.100.0/24).
# Usage: router.sh init | cone | symmetric | udp-blocked | tcp-443 | lossy | capture <file>
set -eu

# Docker does not keep eth0/eth1 in a stable order, so find each side by its subnet.
iface() {
  ip -o -4 addr show | awk -v net="$1" 'index($4, net) == 1 { print $2; exit }'
}
lan=$(iface 10.89.)
wan=$(iface 198.51.100.)
[ -n "$lan" ] && [ -n "$wan" ] || { echo "router.sh: lan or wan interface not found" >&2; exit 1; }

# Every mode starts from the same state, so modes can be switched between tests.
reset() {
  iptables -t nat -F POSTROUTING
  iptables -F FORWARD
  iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  tc qdisc del dev "$lan" root 2>/dev/null || true
  tc qdisc del dev "$wan" root 2>/dev/null || true
  # Old mappings would outlive the mode change.
  conntrack -F 2>/dev/null || true
}

case "${1:-}" in
  init)
    # Docker routes the router out through the site bridge to the host and the internet.
    # Without that route, the public network is the only place it can reach.
    ip route del default 2>/dev/null || true
    iptables -P FORWARD DROP
    # Drop unsolicited packets to the router itself, like a home router. Dropped in INPUT, they
    # never enter the conntrack table. Otherwise a peer's early ICE check to our public port
    # leaves an entry that clashes with our own mapping to that peer, MASQUERADE picks another
    # port, and hole punching fails as if the NAT were symmetric.
    iptables -A INPUT -i "$wan" -m conntrack --ctstate NEW -j DROP
    reset
    ;;
  cone)
    reset
    # MASQUERADE keeps the source port when it is free, so one inside socket gets the same
    # public port for every destination (endpoint-independent mapping).
    iptables -t nat -A POSTROUTING -o "$wan" -j MASQUERADE
    iptables -A FORWARD -i "$lan" -o "$wan" -j ACCEPT
    ;;
  symmetric)
    reset
    # A random public port per connection, so each destination sees a different mapping.
    iptables -t nat -A POSTROUTING -o "$wan" -j MASQUERADE --random-fully
    iptables -A FORWARD -i "$lan" -o "$wan" -j ACCEPT
    ;;
  udp-blocked)
    reset
    # A cone NAT that drops all UDP from the site, so only TCP (TURN over TCP) gets out.
    iptables -t nat -A POSTROUTING -o "$wan" -j MASQUERADE
    iptables -I FORWARD -i "$lan" -p udp -j DROP
    iptables -A FORWARD -i "$lan" -o "$wan" -j ACCEPT
    ;;
  tcp-443)
    reset
    # A strict firewall: only TCP to port 443 gets out.
    iptables -t nat -A POSTROUTING -o "$wan" -j MASQUERADE
    iptables -A FORWARD -i "$lan" -o "$wan" -p tcp --dport 443 -j ACCEPT
    ;;
  lossy)
    reset
    # A cone NAT on a slow, lossy, jittery link. netem shapes what leaves an interface, so it
    # goes on both sides: wan for upload, lan for download.
    iptables -t nat -A POSTROUTING -o "$wan" -j MASQUERADE
    iptables -A FORWARD -i "$lan" -o "$wan" -j ACCEPT
    tc qdisc add dev "$wan" root netem delay 80ms 20ms loss 2% rate 4mbit
    tc qdisc add dev "$lan" root netem delay 80ms 20ms loss 2% rate 4mbit
    ;;
  capture)
    # Every packet that crosses the site's edge, for a test that checks what left the site.
    # --immediate-mode: without it libpcap holds up to a second of packets, which a stop drops.
    exec tcpdump -i "$wan" --immediate-mode -U -w "$2"
    ;;
  *)
    echo "usage: router.sh init|cone|symmetric|udp-blocked|tcp-443|lossy|capture <file>" >&2
    exit 2
    ;;
esac
