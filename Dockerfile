FROM node:20-alpine

WORKDIR /app

# ffmpeg renders the 9:16 deal reel from a listing's photos. Without it
# dealVideo just reports "ffmpeg not installed" and the reel never appears.
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 10000

CMD ["node", "server.cjs"]

