# Throwaway FTP, FTPS and SFTP servers for the FTP and SFTP site tests (E23), from Ubuntu's own
# packages only:
# - ProFTPD on 21: FTP with MLSD, and explicit TLS (FTPS) with a self-signed certificate;
# - ProFTPD's mod_sftp on 2222: an SFTP server that is not OpenSSH;
# - vsftpd on 2121: LIST only, no MLSD, like many shared hosts.
# entrypoint.sh writes the passive ports from the environment, since they must be published 1:1.
FROM ubuntu:24.04
# proftpd-core and vsftpd conflict as packages (both are an "ftp-server"), so vsftpd's own .deb
# is unpacked by hand, next to the libraries it links against.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      proftpd-core proftpd-mod-crypto openssl openssh-client libcap2 libwrap0 libpam-modules \
 && cd /tmp && apt-get download vsftpd && dpkg-deb -x vsftpd_*.deb /tmp/vsftpd \
 && cp /tmp/vsftpd/usr/sbin/vsftpd /usr/sbin/vsftpd \
 && cp /tmp/vsftpd/etc/pam.d/vsftpd /etc/pam.d/vsftpd \
 && rm -rf /tmp/vsftpd* /var/lib/apt/lists/* \
 && ! ldd /usr/sbin/vsftpd | grep -q 'not found' \
 && useradd -m -s /bin/bash ftpuser \
 && echo 'ftpuser:ftp-s3cret' | chpasswd \
 && mkdir -p /etc/proftpd/tls /var/run/vsftpd/empty /var/log/proftpd \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=runova-e2e-ftp' \
      -addext 'subjectAltName=DNS:localhost,DNS:runova-e2e-ftp,IP:127.0.0.1' \
      -keyout /etc/proftpd/tls/key.pem -out /etc/proftpd/tls/cert.pem \
 && chmod 0600 /etc/proftpd/tls/key.pem \
 && ssh-keygen -q -m PEM -t rsa -b 2048 -N '' -f /etc/proftpd/ssh_host_rsa_key \
 && chmod 0600 /etc/proftpd/ssh_host_rsa_key
COPY proftpd.conf /etc/proftpd/runova.conf
COPY vsftpd.conf /etc/vsftpd-runova.conf
COPY entrypoint.sh /entrypoint.sh
# A Windows checkout may turn these into CRLF, which breaks the shebang and vsftpd's YES values.
RUN sed -i 's/\r$//' /entrypoint.sh /etc/proftpd/runova.conf /etc/vsftpd-runova.conf \
 && chmod +x /entrypoint.sh
EXPOSE 21 2121 2222
ENTRYPOINT ["/entrypoint.sh"]
