FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx tsc

ENV PORT=7860
EXPOSE 7860

CMD ["node", "dist/index.js"]