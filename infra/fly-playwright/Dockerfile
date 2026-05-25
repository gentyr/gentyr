FROM node:22-bookworm

# Install system dependencies needed by Playwright browsers + recording
# Based on https://playwright.dev/docs/browsers#linux-system-requirements
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Playwright Chromium dependencies
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
    # code-server: kerberos native module build dependency (fallback when prebuild-install download fails)
    libgssapi-krb5-2 \
    # Native module build toolchain. faiss-node (used by @langchain/community FAISS
    # vector store in packages/sdk-scenarios) compiles its native bindings from source
    # via cmake-js when a prebuilt binary is not available for the target Node ABI/
    # platform. It requires cmake + a C++ toolchain (build-essential) + a BLAS
    # implementation (OpenBLAS) + LAPACK to build the bundled FAISS C++ library.
    # Other node-gyp/cmake-js modules in the dependency tree benefit from the same
    # toolchain when their prebuilt fetch fails.
    build-essential cmake libopenblas-dev liblapack-dev \
    # Recording (Xvfb + ffmpeg) and utilities
    xvfb ffmpeg unclutter xdotool jq git curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm@10

# Install bun (required for packages/visiq-edr-discovery-agent build step)
RUN npm install -g bun@1

# Pre-install Playwright Chromium in base image to avoid 6-13 min download on cold machines.
# The project image (Dockerfile.project) also installs Chromium matching the project's
# @playwright/test version, but this ensures the base image fallback path is fast too.
RUN npx playwright@latest install --with-deps chromium

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
