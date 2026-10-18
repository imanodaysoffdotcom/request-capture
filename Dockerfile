FROM node:20-slim
WORKDIR /app
# Cache bust: v4
COPY . .
RUN mkdir -p logs
EXPOSE 8080
CMD ["node", "server.js"]
