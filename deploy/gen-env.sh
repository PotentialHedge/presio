#!/usr/bin/env bash
# Generate an env file from deploy/.env.example with fresh secrets.
# Edit the values below (or override via env vars), then run:
#   ./deploy/gen-env.sh                       # writes ../.env
#   ./deploy/gen-env.sh ../.env.staging \      # writes a second stack's env,
#     APP_DOMAIN=https://staging.presio.xyz \  # e.g. for the isolated
#     SUPABASE_DOMAIN=https://supabase-staging.presio.xyz
set -euo pipefail
cd "$(dirname "$0")"

# $1, if given, is the output path (default: ../.env, i.e. the repo root).
OUT="${1:-../.env}"

# ---- set these (or override as OUT=... NAME=value ./deploy/gen-env.sh) ----
: "${APP_DOMAIN:=https://presio.xyz}"
# Optional second domain for the APP only — the API stays single-homed on
# SUPABASE_DOMAIN. Empty (the default) produces an ordinary one-domain env.
: "${APP_DOMAIN_ALT:=}"
: "${SUPABASE_DOMAIN:=https://supabase.presio.xyz}"
# Optional viewer domains, paired with APP_DOMAIN / APP_DOMAIN_ALT: where
# audiences watch (see VIEWER_HOST in .env.example). Empty = no split.
: "${VIEWER_DOMAIN:=}"
: "${VIEWER_DOMAIN_ALT:=}"
# Optional former API domain, kept routed so cached service workers still
# calling the old host don't hard-fail after a move.
: "${SUPABASE_DOMAIN_ALT:=}"
: "${ANALYTICS_DOMAIN:=https://analytics.presio.xyz}"
: "${GITHUB_CLIENT_ID:=REPLACE_ME}"
: "${GITHUB_SECRET:=REPLACE_ME}"
: "${GITHUB_ENABLED:=true}"
: "${ENABLE_EMAIL_AUTOCONFIRM:=false}"

# ---- helpers ----
rand()    { openssl rand -hex "${1:-32}"; }
# -E (POSIX ERE) rather than a BRE `\?`, which is a GNU extension: BSD/macOS
# sed leaves it unmatched, silently yielding a host that still has its scheme
# and a Traefik Host() rule that matches nothing.
hostonly(){ printf '%s' "$1" | sed -E 's|https?://||'; }
b64url()  { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {  # $1=role  $2=secret  -> a 10-year HS256 Supabase API key
  local iat exp hdr pl
  iat=$(date +%s); exp=$((iat + 60*60*24*3650))
  hdr=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  pl=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$iat" "$exp" | b64url)
  printf '%s.%s.%s' "$hdr" "$pl" \
    "$(printf '%s' "$hdr.$pl" | openssl dgst -sha256 -hmac "$2" -binary | b64url)"
}

# ---- generate ----
JWT_SECRET=$(rand 32)
ANON_KEY=$(jwt anon "$JWT_SECRET")
SERVICE_ROLE_KEY=$(jwt service_role "$JWT_SECRET")
POSTGRES_PASSWORD=$(rand 24)
DASHBOARD_PASSWORD=$(rand 16)
PG_META_CRYPTO_KEY=$(rand 16)
MINIO_ROOT_PASSWORD=$(rand 24)
S3_PROTOCOL_ACCESS_KEY_ID=$(rand 16)
S3_PROTOCOL_ACCESS_KEY_SECRET=$(rand 32)

override() {  # echo a replacement value for $1, or return 1 if no override
  case "$1" in
    APP_HOST)                 hostonly "$APP_DOMAIN" ;;
    APP_HOST_ALT)             [ -n "$APP_DOMAIN_ALT" ] && hostonly "$APP_DOMAIN_ALT" || echo "" ;;
    SUPABASE_HOST)            hostonly "$SUPABASE_DOMAIN" ;;
    SUPABASE_HOST_ALT)        [ -n "$SUPABASE_DOMAIN_ALT" ] && hostonly "$SUPABASE_DOMAIN_ALT" || echo "" ;;
    SUPABASE_PUBLIC_URL|API_EXTERNAL_URL) echo "$SUPABASE_DOMAIN" ;;
    SITE_URL)                 echo "$APP_DOMAIN" ;;
    VIEWER_HOST)              [ -n "$VIEWER_DOMAIN" ] && hostonly "$VIEWER_DOMAIN" || echo "" ;;
    VIEWER_HOST_ALT)          [ -n "$VIEWER_DOMAIN_ALT" ] && hostonly "$VIEWER_DOMAIN_ALT" || echo "" ;;
    # The app domain first: it is the canonical origin for generated links.
    PUBLIC_BASE_URLS)         echo "$APP_DOMAIN${APP_DOMAIN_ALT:+,$APP_DOMAIN_ALT}" ;;
    # /** wildcard suffix required: GoTrue falls back to SITE_URL for any
    # redirect URL not matching an allow-list entry exactly.
    ADDITIONAL_REDIRECT_URLS) echo "$APP_DOMAIN/**${APP_DOMAIN_ALT:+,$APP_DOMAIN_ALT/**},http://localhost:5173/**" ;;
    # Browsers send Origin even on same-origin fetch/WebSocket, so set this to
    # the app URL so the server's CORS check allows it. Both domains when
    # dual-homed, or the second one's requests are refused — and the viewer
    # domains, whose pages talk to this same server.
    ALLOWED_ORIGIN)           echo "$APP_DOMAIN${APP_DOMAIN_ALT:+,$APP_DOMAIN_ALT}${VIEWER_DOMAIN:+,$VIEWER_DOMAIN}${VIEWER_DOMAIN_ALT:+,$VIEWER_DOMAIN_ALT}" ;;
    ANALYTICS_URL)            echo "$ANALYTICS_DOMAIN" ;;
    GITHUB_ENABLED)           echo "$GITHUB_ENABLED" ;;
    ENABLE_EMAIL_AUTOCONFIRM) echo "$ENABLE_EMAIL_AUTOCONFIRM" ;;
    JWT_SECRET)               echo "$JWT_SECRET" ;;
    ANON_KEY)                 echo "$ANON_KEY" ;;
    SERVICE_ROLE_KEY)         echo "$SERVICE_ROLE_KEY" ;;
    POSTGRES_PASSWORD)        echo "$POSTGRES_PASSWORD" ;;
    DASHBOARD_PASSWORD)       echo "$DASHBOARD_PASSWORD" ;;
    PG_META_CRYPTO_KEY)       echo "$PG_META_CRYPTO_KEY" ;;
    MINIO_ROOT_PASSWORD)      echo "$MINIO_ROOT_PASSWORD" ;;
    S3_PROTOCOL_ACCESS_KEY_ID)     echo "$S3_PROTOCOL_ACCESS_KEY_ID" ;;
    S3_PROTOCOL_ACCESS_KEY_SECRET) echo "$S3_PROTOCOL_ACCESS_KEY_SECRET" ;;
    GITHUB_CLIENT_ID)         echo "$GITHUB_CLIENT_ID" ;;
    GITHUB_SECRET)            echo "$GITHUB_SECRET" ;;
    *) return 1 ;;
  esac
}

[ -e "$OUT" ] && { echo "$OUT already exists — refusing to overwrite." >&2; exit 1; }

while IFS= read -r line; do
  if printf '%s' "$line" | grep -qE '^[A-Z_][A-Z0-9_]*=' && key=${line%%=*} && v=$(override "$key"); then
    printf '%s=%s\n' "$key" "$v"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > "$OUT"
chmod 600 "$OUT"
echo "Wrote $OUT (chmod 600). Set GITHUB_* in it if you left them as REPLACE_ME."
