FROM node:20-slim
WORKDIR /app
# Cache bust: v3
COPY . .
RUN mkdir -p logs
EXPOSE 8080
CMD ["node", "server.js"]
