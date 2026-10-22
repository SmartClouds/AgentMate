# A disposable FTP, FTPS and SFTP server for the backup destination system tests (E28): one user
# with a password, vsftpd with a self-signed certificate (TLS optional) and passive ports
# 30000-30009, and sshd without its per-source penalties (the tests sign in wrong on purpose,
# all from one address). Never shipped.
FROM debian:13
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server vsftpd openssl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /var/run/vsftpd/empty \
 && useradd -m -s /bin/bash keeper \
 && echo 'keeper:keeper-test-pw' | chpasswd \
 && echo 'PerSourcePenalties no' > /etc/ssh/sshd_config.d/tests.conf \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=backup-targets \
      -keyout /etc/ssl/private/vsftpd.key -out /etc/ssl/certs/vsftpd.pem
COPY vsftpd.conf /etc/vsftpd.conf
COPY start.sh /start.sh
EXPOSE 21 22 30000-30009
CMD ["/bin/sh", "/start.sh"]
