# chatbot: LangGraph RAG agent, ChromaDB. Port 8001 (CHATBOT_PORT).
# Build docker/python-base.Dockerfile as bharat-python-base first.
#   docker build -f docker/chatbot.Dockerfile -t bharat-chatbot .
FROM bharat-python-base

WORKDIR /app
COPY . .

ENV PYTHONUNBUFFERED=1
EXPOSE 8001
CMD ["python", "src/server/chatbot/app.py"]
