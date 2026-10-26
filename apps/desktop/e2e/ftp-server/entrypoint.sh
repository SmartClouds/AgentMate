#!/bin/sh
# Writes the passive ports (published 1:1 by the test) and the address to announce, then runs
# both servers. PASV_MIN..PASV_MAX is split in two: the lower half for ProFTPD, the upper for vsftpd.
set -e
MIN=${PASV_MIN:-30000}
MAX=${PASV_MAX:-30009}
ADDRESS=${PASV_ADDRESS:-127.0.0.1}
MID=$(( (MIN + MAX) / 2 ))

{
  cat /etc/proftpd/runova.conf
  echo "PassivePorts $MIN $MID"
  echo "MasqueradeAddress $ADDRESS"
} > /etc/proftpd/proftpd.conf

{
  cat /etc/vsftpd-runova.conf
  echo "pasv_min_port=$(( MID + 1 ))"
  echo "pasv_max_port=$MAX"
  echo "pasv_address=$ADDRESS"
} > /etc/vsftpd.conf

/usr/sbin/vsftpd /etc/vsftpd.conf &
exec /usr/sbin/proftpd --nodaemon --config /etc/proftpd/proftpd.conf
