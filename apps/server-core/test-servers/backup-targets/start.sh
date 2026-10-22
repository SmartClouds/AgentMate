#!/bin/sh
# vsftpd's listener can crash when a client drops the TLS handshake (the tests refuse an unpinned
# certificate on purpose), so it is restarted here instead of being PID 1 and taking sshd with it.
set -e
/usr/sbin/sshd
while true; do
  /usr/sbin/vsftpd /etc/vsftpd.conf || true
  sleep 0.2
done
