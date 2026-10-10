FROM python:3.12-slim

WORKDIR /app
# server.py is standard library only, so there's nothing to pip install.
COPY . .

ENV HOST=0.0.0.0 PORT=8123 GRIDLINES_DB=/app/data/gridlines.db
EXPOSE 8123
CMD ["python", "server/server.py"]
