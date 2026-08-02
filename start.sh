#!/bin/sh
# Copy the read-only secret cookies file to a writable location, since
# yt-dlp needs to write updated session data back into it.
if [ -f /etc/secrets/cookies.txt ]; then
  cp /etc/secrets/cookies.txt /tmp/cookies.txt
fi

# Attempt to start Cloudflare WARP in proxy mode. This is experimental —
# Render's container sandboxing may block the networking access WARP
# needs. If it fails, we log a clear message and continue without it
# (the app still works, just without this particular bot-detection
# workaround for YouTube).
echo "Attempting to start Cloudflare WARP..."
warp-svc &
sleep 3

if warp-cli --accept-tos registration new 2>&1; then
  warp-cli --accept-tos mode proxy 2>&1
  warp-cli --accept-tos connect 2>&1
  sleep 3
  STATUS=$(warp-cli --accept-tos status 2>&1)
  echo "WARP status: $STATUS"
  if echo "$STATUS" | grep -qi "connected"; then
    echo "WARP connected successfully — using proxy at 127.0.0.1:40000"
    export PROXY_URL="socks5://127.0.0.1:40000"
  else
    echo "WARP did not reach Connected state — continuing without proxy."
  fi
else
  echo "WARP registration failed (likely blocked by container sandboxing) — continuing without proxy."
fi

# Start the PO Token provider server in the background. yt-dlp will
# auto-detect it at 127.0.0.1:4416 (its default address) without needing
# any extra configuration.
echo "Starting PO Token provider..."
node /opt/bgutil/server/build/main.js &
sleep 2

npm start