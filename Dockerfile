FROM node:18-slim
RUN apt-get update && apt-get install -y wget gnupg ca-certificates --no-install-recommends && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install && npx playwright install chromium --with-deps
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
