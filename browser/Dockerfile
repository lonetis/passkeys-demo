FROM debian:bookworm-slim

# Git ref of https://github.com/RUB-NDS/passkeys.tools whose extension is baked into the image.
# Keep it in sync with the frontend deployed at PASSKEYS_TOOLS_URL (https://passkeys.tools runs main).
ARG PASSKEYS_TOOLS_REF=main

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        tigervnc-standalone-server \
        socat \
        jq \
        ca-certificates \
        git \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-color-emoji \
    && git clone --depth 1 --branch "${PASSKEYS_TOOLS_REF}" https://github.com/RUB-NDS/passkeys.tools.git /tmp/passkeys.tools \
    && cp -r /tmp/passkeys.tools/extension /opt/passkeys-tools-extension \
    && rm -rf /tmp/passkeys.tools \
    && apt-get purge -y git \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 browser \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && mkdir -p /etc/chromium/policies/managed \
    && chown browser:browser /etc/chromium/policies/managed \
    # Chromium writes the extension's indexed ruleset (_metadata) into the unpacked extension
    # directory; if it cannot, the extension fails to load and DevTools never comes up.
    && chown -R browser:browser /opt/passkeys-tools-extension

COPY entrypoint.sh /usr/local/bin/entrypoint.sh

USER browser
WORKDIR /home/browser

EXPOSE 5900 9223

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
