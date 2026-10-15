# 408 考研学习助手 · 生产镜像（零第三方依赖，无需 npm install）
FROM node:24-alpine

WORKDIR /app

# 容器内必须监听 0.0.0.0，否则宿主机端口映射无法访问
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4080 \
    KY_DB=/var/lib/kaoyan/kaoyan.db

COPY . .

# 数据目录（数据库挂载点）
RUN mkdir -p /var/lib/kaoyan

EXPOSE 4080

# 简单健康检查：能取到 /api/overview 即视为健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4080)+'/api/overview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
