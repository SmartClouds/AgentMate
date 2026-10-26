#!/bin/sh
# Starts the official WordPress image with Apache on RUNOVA_PORT instead of 80, the same port
# as the host mapping, so the site's own loopback requests to home_url() reach it from inside the
# container. Then hands over to the image's entrypoint, which copies WordPress in on first start.
set -e
PORT="${RUNOVA_PORT:-80}"
sed -i "s/^Listen 80\$/Listen ${PORT}/" /etc/apache2/ports.conf
sed -i "s/<VirtualHost \*:80>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-enabled/000-default.conf
exec docker-entrypoint.sh apache2-foreground
