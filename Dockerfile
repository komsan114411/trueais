FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY .env.example ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
# ข้อมูลอยู่ที่ /app/data (สลิป + ไฟล์สำรอง และฐานข้อมูล SQLite ถ้าไม่ได้ใช้ PostgreSQL)
#   docker compose: ผูกกับโฟลเดอร์ ./data  |  Railway: เพิ่ม Volume ที่ /app/data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
