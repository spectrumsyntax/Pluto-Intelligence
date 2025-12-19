# Use the official Puppeteer image which includes all necessary dependencies and Chrome
FROM ghcr.io/puppeteer/puppeteer:24.33.1

# 1. Essential Environment Variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# 2. Switch to root to ensure we can set up the directory properly
USER root

WORKDIR /usr/src/app

# 3. Copy package files and fix ownership BEFORE installing
COPY package*.json ./
RUN chown -R pptruser:pptruser /usr/src/app

# 4. Switch back to the safe user
USER pptruser

# 5. Install dependencies
RUN npm install 

# 6. Copy application code (maintaining pptruser ownership)
COPY --chown=pptruser:pptruser . .

# 7. Start the application
CMD ["node", "server.js"]