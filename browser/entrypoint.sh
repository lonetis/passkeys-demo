#!/bin/bash
# Runs one demo browser: a VNC-backed X display, Chromium with the PASSKEYS-ATTACKER
# extension, and a CDP port reachable from the demo app.
#
# Chromium is restarted with a wiped profile whenever it exits. The demo app relies on
# this for "Reset": it closes the browser via CDP and gets a pristine one back.
set -euo pipefail

SCREEN_WIDTH="${SCREEN_WIDTH:-1152}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-720}"
THEME_COLOR="${THEME_COLOR:-#1565C0}"
ALLOWED_HOSTS="${ALLOWED_HOSTS:-passkeys.tools}"

EXTENSION_DIR=/opt/passkeys-tools-extension
PROFILE_DIR=/tmp/chromium-profile
VNC_PORT=5900
CDP_INTERNAL_PORT=9222
CDP_EXPOSED_PORT=9223

export DISPLAY=:0

write_policies() {
    # Managed policies: skin color, no password/translate prompts, and navigation limited to
    # the demo sites so the public remote browser cannot be used for general browsing.
    jq -n \
        --arg theme "$THEME_COLOR" \
        --arg hosts "$ALLOWED_HOSTS" \
        '{
            BrowserThemeColor: $theme,
            PasswordManagerEnabled: false,
            PasswordLeakDetectionEnabled: false,
            AutofillAddressEnabled: false,
            AutofillCreditCardEnabled: false,
            TranslateEnabled: false,
            DefaultPopupsSetting: 1,
            DefaultBrowserSettingEnabled: false,
            PromotionalTabsEnabled: false,
            MetricsReportingEnabled: false,
            BrowserSignin: 0,
            SyncDisabled: true,
            BookmarkBarEnabled: false,
            URLBlocklist: ["*"],
            URLAllowlist: (($hosts | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) + ["chrome-extension://*"])
        }' > /etc/chromium/policies/managed/demo.json
}

run_chromium_forever() {
    while true; do
        rm -rf "$PROFILE_DIR"
        /usr/lib/chromium/chromium \
            --user-data-dir="$PROFILE_DIR" \
            --remote-debugging-port="$CDP_INTERNAL_PORT" \
            --load-extension="$EXTENSION_DIR" \
            --disable-extensions-except="$EXTENSION_DIR" \
            --window-position=0,0 \
            --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
            --no-first-run \
            --no-default-browser-check \
            --no-sandbox \
            --test-type \
            --disable-dev-shm-usage \
            --password-store=basic \
            --hide-crash-restore-bubble \
            --lang=en-US \
            about:blank || echo "chromium exited with status $?" >&2
        sleep 1
    done
}

write_policies

Xvnc "$DISPLAY" \
    -geometry "${SCREEN_WIDTH}x${SCREEN_HEIGHT}" \
    -depth 24 \
    -rfbport "$VNC_PORT" \
    -SecurityTypes None \
    -AlwaysShared \
    -AcceptSetDesktopSize=0 \
    -desktop "passkeys-demo" &

# Chromium only binds its DevTools port to localhost when running with a UI.
socat "TCP-LISTEN:${CDP_EXPOSED_PORT},fork,reuseaddr" "TCP:127.0.0.1:${CDP_INTERNAL_PORT}" &

for _ in $(seq 1 50); do
    [ -e /tmp/.X11-unix/X0 ] && break
    sleep 0.1
done

run_chromium_forever &

# Exit (and let Docker restart the container) as soon as any service dies.
wait -n
exit 1
