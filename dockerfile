FROM ghcr.io/puppeteer/puppeteer:24.33.1

# 1. Skip downloading another browser during npm install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# 2. Switch to root to handle permissions
USER root

WORKDIR /usr/src/app

# 3. Copy package files and change ownership to pptruser
COPY package*.json ./
RUN chown -R pptruser:pptruser /usr/src/app

# 4. Switch to pptruser to install and run the app
USER pptruser

# 5. Install dependencies
RUN npm install 

# 6. Copy the rest of your application code
# (As pptruser, these files will be owned by the user)
COPY --chown=pptruser:pptruser . .

# 7. Start the application
CMD ["node", "server.js"]