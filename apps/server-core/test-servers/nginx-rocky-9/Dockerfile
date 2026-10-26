# check=skip=SecretsUsedInArgOrEnv
# nginx from nginx.org's stable repository on Rocky Linux 9, for the nginx -t harness (E10). The
# system tests write rendered releases into it, check them with nginx -t, reload and serve them.
# The repository key must carry exactly the fingerprints nginx.org publishes, and dnf checks
# packages against that local copy only. nginx.conf is wired the way the core's install will do
# it: our include inside http, a stream block with our other include, the stock default site
# gone. Never shipped. BuildKit's secret check is skipped above because the ARG only holds
# nginx.org's public key fingerprints.
FROM rockylinux/rockylinux:9
ARG NGINX_KEY_FINGERPRINTS="573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 8540A6F18833A80E9C1653A42FD21310B49F6B46 9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3"
RUN curl -fsSL --retry 5 --retry-all-errors https://nginx.org/keys/nginx_signing.key -o /tmp/nginx_signing.key \
 && found="$(gpg --batch --homedir "$(mktemp -d)" --with-colons --import-options show-only --import /tmp/nginx_signing.key \
      | awk -F: '$1 == "pub" { primary = 1; next } $1 == "fpr" && primary { print $10; primary = 0 }' | sort | xargs)" \
 && expected="$(printf '%s\n' $NGINX_KEY_FINGERPRINTS | sort | xargs)" \
 && if [ "$found" != "$expected" ]; then echo "nginx.org key fingerprints are '$found', expected '$expected'" >&2; exit 1; fi \
 && mv /tmp/nginx_signing.key /etc/pki/rpm-gpg/RPM-GPG-KEY-nginx \
 && printf '[nginx-stable]\nname=nginx stable repo\nbaseurl=https://nginx.org/packages/centos/$releasever/$basearch/\ngpgcheck=1\nenabled=1\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-nginx\nmodule_hotfixes=true\n' > /etc/yum.repos.d/nginx.repo \
 && dnf -y --setopt=install_weak_deps=False install nginx \
 && dnf clean all \
 && rm /etc/nginx/conf.d/default.conf \
 && mkdir -p /etc/nginx/runova/releases/0 /var/www/runova/acme /var/www/runova/sites \
 && touch /etc/nginx/runova/releases/0/http.conf /etc/nginx/runova/releases/0/stream.conf \
 && ln -s releases/0 /etc/nginx/runova/current \
 && sed -i 's|^\( *\)include /etc/nginx/conf.d/\*\.conf;|&\n\1include /etc/nginx/runova/current/http.conf;|' /etc/nginx/nginx.conf \
 && printf '\nstream {\n    include /etc/nginx/runova/current/stream.conf;\n}\n' >> /etc/nginx/nginx.conf \
 && grep -q 'runova/current/http.conf' /etc/nginx/nginx.conf \
 && nginx -t
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
