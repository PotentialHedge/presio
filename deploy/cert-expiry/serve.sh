#!/bin/sh
# Serve check.sh over HTTP on the internal network, for Uptime Kuma to poll.
#
# Deliberately not exposed through Traefik: it carries no secrets, but it is
# infrastructure detail and nothing outside the compose network needs it.
set -eu

apk add --no-cache openssl busybox-extras >/dev/null 2>&1

mkdir -p /www/cgi-bin
# busybox httpd runs anything under cgi-bin/ as CGI. The wrapper emits the
# header block; check.sh stays a plain script that is runnable by hand:
#   docker exec presio-cert-expiry /srv/check.sh
cat > /www/cgi-bin/check <<'CGI'
#!/bin/sh
printf 'Content-Type: text/plain\r\n\r\n'
exec /srv/check.sh
CGI
chmod +x /www/cgi-bin/check

exec httpd -f -p 8080 -h /www
