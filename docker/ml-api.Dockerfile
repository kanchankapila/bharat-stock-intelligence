# ml-api: DL training/inference, outcome resolution. Port 8000 (PYTHON_API_PORT).
# Build docker/python-base.Dockerfile as bharat-python-base first.
#   docker build -f docker/ml-api.Dockerfile -t bharat-ml-api .
FROM bharat-python-base

WORKDIR /app
COPY . .

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "src/server/python_api.py"]
