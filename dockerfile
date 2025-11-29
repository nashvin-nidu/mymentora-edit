FROM node:20-alpine

# Install ffmpeg (Alpine uses a very small build)
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]



