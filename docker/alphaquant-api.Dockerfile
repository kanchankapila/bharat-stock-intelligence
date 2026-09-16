# alphaquant-api: backtesting, scoring, TV bridge, optimisation. Port 8002 (PYTHON_PORT).
# Build docker/python-base.Dockerfile as bharat-python-base first.
#   docker build -f docker/alphaquant-api.Dockerfile -t bharat-alphaquant-api .
FROM bharat-python-base

WORKDIR /app
COPY . .

WORKDIR /app/backend-python
ENV PYTHONUNBUFFERED=1
EXPOSE 8002
CMD ["python", "main.py"]
