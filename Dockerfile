# 1. Preporučeni oficijelni Playwright image!
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# 2. Kopiraj package.json, package-lock.json i install dependencies
COPY package*.json ./
RUN npm install

# 3. Kopiraj tvoj kod
COPY . .

# 4. Defaultna komanda
CMD ["node", "scraper.js"]
