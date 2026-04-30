FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

# Chromium уже установлен в базовом образе
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
