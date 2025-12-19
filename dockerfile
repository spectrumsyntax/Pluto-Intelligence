FROM ghcr.io/puppeteer/puppeteer:24.33.1

# 1. Skip downloading another browser during npm install
# and set the path for the pre-installed Chrome binary
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

WORKDIR /usr/src/app

# 2. Copy package files first 
# (Note the space before ./ to ensure two arguments are provided)
COPY package*.json ./

# 3. Install dependencies using 'npm ci' for clean production builds
RUN npm ci 

# 4. Copy the rest of your application code
COPY . .

# 5. Start the application
# Ensure your server.js uses process.env.PORT or defaults to 10000
CMD ["node", "server.js"]