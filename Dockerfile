FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Используем браузер который уже есть в образе, не скачиваем новый
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
