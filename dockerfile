FROM ghcr.io/puppeteer/puppeteer:24.33.1

# Skip downloading another browser during npm install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# Switch to root to fix directory ownership
USER root
WORKDIR /usr/src/app

# Copy package files first
COPY package*.json ./
RUN chown -R pptruser:pptruser /usr/src/app

# Switch to the limited user (Security requirement for Puppeteer)
USER pptruser

# Install dependencies (will use pptruser permissions)
RUN npm install 

# Copy code with correct ownership
COPY --chown=pptruser:pptruser . .

# Expose port (Render requirement)
EXPOSE 10000

# Final start command
CMD ["node", "server.js"]