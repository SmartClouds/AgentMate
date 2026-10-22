# A disposable Rocky Linux 9 server for installer and system tests: systemd as PID 1 and sshd, with
# a root login and a non-root user in wheel, whose sudo asks for the password. Never shipped.
FROM rockylinux/rockylinux:9
ENV container=docker
# dnf picks a mirror at random, and a slow one held a nightly install for 13 minutes (53 kB/s for
# BaseOS's 41 MB of metadata). Under minrate for the default 30 seconds, dnf gives that mirror up and
# takes the next. The installs the tests run inside the server, Docker's among them, read this too.
RUN printf '\nminrate=300k\n' >> /etc/dnf/dnf.conf
RUN dnf -y install systemd openssh-server sudo passwd procps-ng tar gzip policycoreutils \
 && dnf clean all \
 && ssh-keygen -A \
 && echo 'root-test-pw' | passwd --stdin root \
 && sed -ri 's/^#?PermitRootLogin .*/PermitRootLogin yes/; s/^#?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -ri 's/^(session\s+)required(\s+pam_loginuid\.so)/\1optional\2/' /etc/pam.d/sshd \
 && useradd -m deployer \
 && echo 'deployer-test-pw' | passwd --stdin deployer \
 && usermod -aG wheel deployer \
 && systemctl enable sshd
# Docker inside the server (E06) keeps its images and layers off the container's own overlay
# root, which the kernel refuses to stack another overlay on.
VOLUME ["/var/lib/docker", "/var/lib/containerd"]
STOPSIGNAL SIGRTMIN+3
EXPOSE 22
CMD ["/sbin/init"]
