FROM mcr.microsoft.com/playwright:v1.48.0-noble

# Install pnpm globally
RUN npm install -g pnpm@9

# Install jq for JSON processing in remote-runner.sh, xvfb + ffmpeg for window-level recording
RUN apt-get update && apt-get install -y --no-install-recommends jq xvfb ffmpeg && rm -rf /var/lib/apt/lists/*

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
ENV NODE_ENV=production
ENV CI=true
ENV DEMO_HEADLESS=1
ENV DEMO_SLOW_MO=0

ENTRYPOINT ["/app/remote-runner.sh"]
