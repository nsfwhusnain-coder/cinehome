FROM oven/bun:1

WORKDIR /app

# System deps for Playwright Chromium + ffmpeg (transcoding) + AMD VAAPI userspace driver.
# NOTE on hardware encode: the container receives ONLY /dev/dri/renderD128 (the AMD
# Vega iGPU render node — see docker-compose devices). The host's NVIDIA card is
# deliberately NOT exposed: its driver is unloaded host-side, so it has no /dev/dri
# node at all, making it structurally impossible for this container to touch it.
# ffmpeg uses h264_vaapi (AMD) for ~3.3x realtime 1080p; libx264 is the software fallback.
# (Base image is Debian 13/trixie: mesa-va-drivers provides the AMD VAAPI driver;
#  libva-mesa-driver was the old Debian 11/12 name and does not exist here.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        mesa-va-drivers \
        vainfo \
    && rm -rf /var/lib/apt/lists/*

# Install main app dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install scraper mini-service dependencies
COPY mini-services/stream-scraper/package.json ./mini-services/stream-scraper/package.json
RUN cd mini-services/stream-scraper && bun install

# Install headless Chromium + its OS-level deps for Playwright
RUN bunx playwright install --with-deps chromium

# Copy the rest of the source
COPY . .

# Generate Prisma client and build the Next.js standalone server
RUN bunx prisma generate
RUN rm -rf .next && bun run build

# Next's standalone tracing can miss the Prisma query engine binary — copy it in explicitly
RUN mkdir -p .next/standalone/node_modules/.prisma .next/standalone/node_modules/@prisma \
    && cp -r node_modules/.prisma/. .next/standalone/node_modules/.prisma/ \
    && cp -r node_modules/@prisma/client/. .next/standalone/node_modules/@prisma/client/

ENV NODE_ENV=production

EXPOSE 3000 3030

RUN chmod +x start.sh
CMD ["./start.sh"]
