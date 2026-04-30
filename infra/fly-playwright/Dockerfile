FROM node:22-bookworm

# Install system dependencies needed by Playwright browsers + recording
# Based on https://playwright.dev/docs/browsers#linux-system-requirements
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Playwright Chromium dependencies
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
    # Recording (Xvfb + ffmpeg) and utilities
    xvfb ffmpeg unclutter xdotool jq git curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10

# Create working directories
WORKDIR /app
RUN mkdir -p /cache /app/.artifacts /app/project

# Volume mount point for pnpm store + dep caching
VOLUME /cache

# Copy runner script
COPY remote-runner.sh /app/remote-runner.sh
RUN chmod +x /app/remote-runner.sh

# Default env vars (overridden at machine creation)
ENV PNPM_STORE_DIR=/cache/pnpm-store
ENV CI=true
ENV DEMO_HEADLESS=1
ENV DEMO_SLOW_MO=0

ENTRYPOINT ["/app/remote-runner.sh"]
