# The Ubuntu 24.04 test server with ufw installed and off, as on a fresh VPS, for the firewall
# system tests. Built on top of the base image (the test helper builds that first). Run it
# privileged: ufw needs the kernel's netfilter. Never shipped.
FROM runova-test-server:ubuntu-24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ufw iptables nftables iproute2 \
 && rm -rf /var/lib/apt/lists/*
