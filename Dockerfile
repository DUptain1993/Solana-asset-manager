FROM node:22-slim

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "supervisor.js"]
