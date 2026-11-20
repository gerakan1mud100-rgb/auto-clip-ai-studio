FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg curl python3 && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p bin && cp /usr/local/bin/yt-dlp /app/bin/yt-dlp_linux && chmod a+rx /app/bin/yt-dlp_linux
RUN npm run build
EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
