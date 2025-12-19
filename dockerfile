# Start with the official Puppeteer image
FROM ghcr.io/puppeteer/puppeteer:24.33.1

# 1. Essential Environment Variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# 2. Switch to root to perform system installations and fix permissions
USER root

# 3. Explicitly install Google Chrome Stable to ensure binaryExists is true
# This fixes the "binaryExists: false" error seen in the debug logs.
RUN apt-get update && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# 4. Copy package files and fix ownership
COPY package*.json ./
RUN chown -R pptruser:pptruser /usr/src/app

# 5. Switch back to the safe user provided by the base image
USER pptruser

# 6. Install Node dependencies
RUN npm install 

# 7. Copy application code
COPY --chown=pptruser:pptruser . .

# 8. Start the application
CMD ["node", "server.js"]