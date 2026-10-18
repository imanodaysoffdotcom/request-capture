FROM node:20-slim
WORKDIR /app
COPY server.js .
RUN mkdir -p logs
EXPOSE 8080 8081
CMD ["node", "server.js"]
