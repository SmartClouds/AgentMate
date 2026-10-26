# The Rocky Linux 9 test server with firewalld installed and running, as on a fresh RHEL-family
# server, for the firewall system tests. Built on top of the base image (the test helper builds
# that first). Run it privileged: firewalld needs the kernel's nftables. Never shipped.
FROM runova-test-server:rocky-9
RUN dnf -y install firewalld nftables iproute \
 && dnf clean all \
 && systemctl enable firewalld
